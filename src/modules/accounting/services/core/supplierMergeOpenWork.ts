/**
 * What a supplier merge moves besides its documents (#1655 review): the open work and the pairing that would otherwise be left
 * on a supplier no page shows.
 *
 * - intercompany_connection_sides.supplier_id (mig 1000): the intercompany pairing reads a side by its supplier (pairingRead),
 *   so a side left on the merged-away supplier silently stops pairing. At most one side per (company, supplier) holds it
 *   (intercompany_sides_supplier_uq): when the survivor already has one too, the merge is refused (`sideRefusal`), as moving
 *   would break that index. The side guard needs a session user with a write role in the company, which a merge has.
 * - supplier_expectations (one per company + supplier) and the expected_invoice_alerts (unique per company + supplier +
 *   expected_by): moved to the survivor. Where the survivor already has an expectation, or an alert for the same date, the
 *   survivor's row stays and the source's open one is dropped. A resolved or dismissed alert moves too when the survivor has none
 *   for its date: the gap scan keys on (supplier, date), so one left on the source would let it raise that date again on the
 *   survivor, and the chase send a reminder someone dismissed (Codex gate at ecc452ea6b, finding 1).
 *
 * supplier_id tables a merge deliberately does NOT move (every supplier_id column in the schema was checked):
 * - supplier_bank_verifications: append-only, a verification of THAT supplier's bank details; it must not vouch for the survivor's.
 * - fraud_alerts, capture_events.resolved_supplier_id: history of what was seen against the row at the time.
 * - bank_transactions.predicted_supplier_id / suggested_supplier_id: transient suggestions, recomputed.
 * - supplier_statement_reconciliations: a reconciliation of THAT supplier's statement, history.
 * - supplier_contacts, supplier_activities, supplier_coding_rules / _history, bank_categorisation_rules: the merged-away
 *   supplier's own master data and rules; the survivor keeps its own, and folding two sets together (duplicate contacts,
 *   clashing coding rules) is a product decision nobody has made. They stay readable on the row.
 * Documents (payments, bills, both PO tables, credit notes) always move: nothing else shows them.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from './auditTrailService';

export const BOTH_SIDES_REFUSAL =
  'Both suppliers are the partner of an intercompany connection. Disconnect one of them from its connection before merging, so the connection keeps exactly one supplier.';

/** A reason to refuse: the source and the survivor both hold an intercompany side. Locks the source's side. */
export async function sideRefusal(companyId: string, sourceId: string, targetId: string): Promise<string | null> {
  const source = (await sql`
    SELECT id FROM intercompany_connection_sides
     WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID FOR UPDATE
  `) as DbRow[];
  if (!source[0]) return null;
  const target = (await sql`
    SELECT id FROM intercompany_connection_sides
     WHERE company_id = ${companyId}::UUID AND supplier_id = ${targetId}::UUID FOR SHARE
  `) as DbRow[];
  return target[0] ? BOTH_SIDES_REFUSAL : null;
}

export const SIDE_GUARD_REFUSAL =
  'The intercompany connection of this supplier cannot be changed right now: it needs a user with a write role in this company, on a connection that is not revoked. Fix that first, then merge.';

/**
 * The intercompany sides guard's own refusals (migration 1002, intercompany_sides_guard): its SQLSTATE AND its exact message.
 * Anything else (a unique violation, a deadlock, a driver fault, the read-committed 40001) is not the guard and is rethrown.
 * `supplierMergeSideGuard.test.ts` reads the guard's SQL and fails when a RAISE is not listed here, so this cannot drift.
 */
export const SIDE_GUARD_ERRORS: ReadonlyArray<{ code: string; message: string }> = [
  { code: '23503', message: 'no such connection' },
  { code: '23514', message: 'a side keeps its connection and its company' },
  { code: '23514', message: "a revoked connection's sides cannot change" },
  { code: '23514', message: "a side belongs to one of the connection's two companies, facing the other" },
  { code: '42501', message: 'a side is changed by a user with a write role in its company' },
  { code: '23514', message: 'auto-accept is only for a group connection' },
  { code: '23514', message: 'auto-accept needs both companies to be current members of one group' },
  { code: '23503', message: "the customer is not this company's" },
  { code: '23503', message: "the supplier is not this company's" },
  { code: '23503', message: "the loan account is not this company's" },
  { code: '23503', message: "the default expense account is not this company's" },
  { code: '23503', message: "a default dimension is not this company's" },
];

const isSideGuardError = (err: unknown): boolean => {
  const { code, message } = err as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' && SIDE_GUARD_ERRORS.some((g) => g.code === code && g.message === message);
};

/**
 * Points the source's intercompany side at the survivor (after `sideRefusal` found none to refuse). The sides guard may
 * refuse (a revoked connection, a session without a write role): that is answered as a refusal text, not thrown as a 500.
 * It runs in a savepoint, so the refused statement leaves the transaction usable. Call it BEFORE any other write: a 400
 * on the request transaction commits what was written.
 */
export async function moveIntercompanySide(
  companyId: string, sourceId: string, targetId: string,
): Promise<{ moved: number; refusal: string | null }> {
  try {
    const moved = await withSavepoint('supplier_merge_side', async () => (await sql`
      UPDATE intercompany_connection_sides SET supplier_id = ${targetId}::UUID
       WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
       RETURNING id
    `) as DbRow[]);
    return { moved: moved.length, refusal: null };
  } catch (err) {
    if (!isSideGuardError(err)) throw err;
    log.warn('Supplier merge: the intercompany sides guard refused the move', {
      companyId, sourceId, targetId, code: (err as { code?: string }).code, error: (err as Error).message,
    }, 'duplicate-merge');
    return { moved: 0, refusal: SIDE_GUARD_REFUSAL };
  }
}

export interface MergeActor { userId: string; via: string }

/**
 * Moves the expectation and the open alerts to the survivor, and the chase opt-out with them. Returns the rows changed (not
 * transactions: the caller keeps them out of its moved-transactions count).
 *
 * - The alerts of both suppliers are locked FOR UPDATE first (id order), so a cron stamp that arrives meanwhile waits and
 *   then lands on the merged row. The gap scan (detectGaps) takes the supplier row before it writes an alert, so it waits for the
 *   merge's supplier lock instead (lock order: supplier rows, then alerts, then expectations, in both). The cron itself does not lock: it reads a pending alert, sends, then stamps by id
 *   (missingInvoiceChaseService), so a chase already on its way when the merge commits can still go out; stated in the PR.
 * - suppliers.chase_opted_out: if the source is muted the survivor becomes muted (the safe default for outbound messages),
 *   with an audit row; a muted survivor stays muted. Never refused.
 * - Where the survivor already has an alert for the same date, the survivor's row stays and takes the MORE ADVANCED state of
 *   the two (resolved / dismissed > chased > pending) and the resolving bill, keeping its OWN chase facts and taking the
 *   source's only where its own are empty: a chased source alert must not
 *   lose to a pending survivor one (the cron would chase again), and a resolved one (its bill now on the survivor) must not
 *   leave a pending survivor alert to be chased for an invoice that arrived. The source's open duplicate is then dropped; its
 *   resolved / dismissed one stays on the source as history (the survivor's row for that date now carries its state).
 * - The survivor's expectation wins over the source's, and the moved alerts follow it. An alert left on the source is never
 *   pointed at an expectation of the survivor: its expectation link is cleared when the expectation moves (or goes, ON DELETE SET
 *   NULL), so an alert's supplier_id and its expectation's supplier_id never disagree.
 */
export async function moveExpectationsAndAlerts(
  companyId: string, sourceId: string, targetId: string, actor: MergeActor,
): Promise<number> {
  let moved = 0;
  await sql`
    SELECT id FROM expected_invoice_alerts
     WHERE company_id = ${companyId}::UUID AND supplier_id = ANY(${[sourceId, targetId]}::UUID[])
     ORDER BY id FOR UPDATE
  `;
  const muted = (await sql`
    UPDATE suppliers SET chase_opted_out = TRUE
     WHERE id = ${targetId}::UUID AND company_id = ${companyId}::UUID AND chase_opted_out = FALSE
       AND EXISTS (SELECT 1 FROM suppliers s WHERE s.id = ${sourceId}::UUID AND s.company_id = ${companyId}::UUID AND s.chase_opted_out)
     RETURNING id
  `) as DbRow[];
  if (muted[0]) {
    moved += 1;
    await logAuditOrThrow({
      companyId, userId: actor.userId, action: 'update', entityType: 'supplier', entityId: targetId,
      changes: {
        fields: [{ field: 'chase_opted_out', old: 'false', new: 'true', label: 'Chase opt-out' }],
        metadata: { source: actor.via, mergedFrom: sourceId },
      },
    });
  }

  const own = (await sql`
    SELECT id FROM supplier_expectations WHERE company_id = ${companyId}::UUID AND supplier_id = ${targetId}::UUID
  `) as DbRow[];
  const src = (await sql`
    SELECT id FROM supplier_expectations WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
  `) as DbRow[];
  const ownId = own[0] ? String(own[0].id) : null;
  if (src[0] && !ownId) {
    const e = (await sql`
      UPDATE supplier_expectations SET supplier_id = ${targetId}::UUID, updated_at = NOW()
       WHERE id = ${String(src[0].id)}::UUID AND company_id = ${companyId}::UUID RETURNING id
    `) as DbRow[];
    moved += e.length;
  }

  // Same-date clash: the survivor's alert takes the more advanced state, then (equal chased) the chase facts it lacks.
  // The resolution (status, resolving bill) comes from the more advanced alert; the chase facts stay the survivor's where it
  // has them, so a message the survivor really sent is never erased by a source that was never chased, and are filled from
  // the source only where the survivor's are empty. (Equal rank needs no status change: only the chase facts are filled.)
  await sql`
    UPDATE expected_invoice_alerts t SET
           status = CASE WHEN (CASE a.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 WHEN 'chased' THEN 1 ELSE 0 END)
                               > (CASE t.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 WHEN 'chased' THEN 1 ELSE 0 END)
                              THEN a.status ELSE t.status END,
           resolved_invoice_id = CASE WHEN (CASE a.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 ELSE 0 END)
                                         > (CASE t.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 ELSE 0 END)
                                      THEN a.resolved_invoice_id ELSE t.resolved_invoice_id END,
           resolved_at = CASE WHEN (CASE a.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 ELSE 0 END)
                                   > (CASE t.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 ELSE 0 END)
                                THEN a.resolved_at ELSE t.resolved_at END,
           dismissed_reason = CASE WHEN (CASE a.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 ELSE 0 END)
                                        > (CASE t.status WHEN 'resolved' THEN 2 WHEN 'dismissed' THEN 2 ELSE 0 END)
                                     THEN a.dismissed_reason ELSE t.dismissed_reason END,
           chased_at = COALESCE(t.chased_at, a.chased_at), chase_method = COALESCE(t.chase_method, a.chase_method),
           chase_to_address = COALESCE(t.chase_to_address, a.chase_to_address), updated_at = NOW()
      FROM expected_invoice_alerts a
     WHERE t.company_id = ${companyId}::UUID AND t.supplier_id = ${targetId}::UUID
       AND a.company_id = t.company_id AND a.supplier_id = ${sourceId}::UUID AND a.expected_by = t.expected_by
  `;
  const dropped = (await sql`
    DELETE FROM expected_invoice_alerts a
     WHERE a.company_id = ${companyId}::UUID AND a.supplier_id = ${sourceId}::UUID AND a.status IN ('pending', 'chased')
       AND EXISTS (SELECT 1 FROM expected_invoice_alerts t
                    WHERE t.company_id = a.company_id AND t.supplier_id = ${targetId}::UUID AND t.expected_by = a.expected_by)
     RETURNING a.id
  `) as DbRow[];
  moved += dropped.length;
  // Every source alert the survivor has no row for that date moves: the open ones (their duplicates were dropped above) and the
  // resolved / dismissed ones, which are what keeps the gap scan from raising that date again.
  const alerts = (await sql`
    UPDATE expected_invoice_alerts a SET supplier_id = ${targetId}::UUID, updated_at = NOW(),
           expectation_id = CASE WHEN ${ownId}::UUID IS NULL THEN a.expectation_id ELSE ${ownId}::UUID END
     WHERE a.company_id = ${companyId}::UUID AND a.supplier_id = ${sourceId}::UUID
       AND NOT EXISTS (SELECT 1 FROM expected_invoice_alerts t
                        WHERE t.company_id = a.company_id AND t.supplier_id = ${targetId}::UUID AND t.expected_by = a.expected_by)
     RETURNING a.id
  `) as DbRow[];
  moved += alerts.length;
  // What stays on the source (history of a date the survivor holds) must not name the expectation that is now the survivor's.
  if (src[0] && !ownId) {
    await sql`
      UPDATE expected_invoice_alerts SET expectation_id = NULL
       WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID AND expectation_id = ${String(src[0].id)}::UUID
    `;
  }

  if (src[0] && ownId) {
    await sql`DELETE FROM supplier_expectations WHERE id = ${String(src[0].id)}::UUID AND company_id = ${companyId}::UUID`;
    moved += 1;
  }
  return moved;
}
