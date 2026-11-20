/**
 * What a supplier merge moves besides its documents (#1655 review): the open work and the pairing that would otherwise be left
 * on a supplier no page shows.
 *
 * - intercompany_connection_sides.supplier_id (mig 1000): the intercompany pairing reads a side by its supplier (pairingRead),
 *   so a side left on the merged-away supplier silently stops pairing. At most one side per (company, supplier) holds it
 *   (intercompany_sides_supplier_uq): when the survivor already has one too, the merge is refused (`sideRefusal`), as moving
 *   would break that index. The side guard needs a session user with a write role in the company, which a merge has.
 * - supplier_expectations (one per company + supplier) and the OPEN expected_invoice_alerts (pending / chased; unique per
 *   company + supplier + expected_by): moved to the survivor. Where the survivor already has an expectation, or an alert for the
 *   same date, the survivor's row stays and the source's is dropped. Resolved and dismissed alerts are history and stay.
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
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

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

/** Points the source's intercompany side at the survivor (after `sideRefusal` found none to refuse). */
export async function moveIntercompanySide(companyId: string, sourceId: string, targetId: string): Promise<number> {
  const moved = (await sql`
    UPDATE intercompany_connection_sides SET supplier_id = ${targetId}::UUID
     WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
     RETURNING id
  `) as DbRow[];
  return moved.length;
}

/** Moves the expectation and the open alerts to the survivor, keeping the survivor's where both have one. Returns the rows moved. */
export async function moveExpectationsAndAlerts(companyId: string, sourceId: string, targetId: string): Promise<number> {
  let moved = 0;
  const own = (await sql`
    SELECT id FROM supplier_expectations WHERE company_id = ${companyId}::UUID AND supplier_id = ${targetId}::UUID
  `) as DbRow[];
  const src = (await sql`
    SELECT id FROM supplier_expectations WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
  `) as DbRow[];
  if (src[0] && !own[0]) {
    await sql`UPDATE supplier_expectations SET supplier_id = ${targetId}::UUID, updated_at = NOW() WHERE id = ${String(src[0].id)}::UUID`;
    moved += 1;
  } else if (src[0] && own[0]) {
    // The survivor's expectation stays: the source's alerts (history included) follow it, then the source's is dropped.
    await sql`
      UPDATE expected_invoice_alerts SET expectation_id = ${String(own[0].id)}::UUID
       WHERE company_id = ${companyId}::UUID AND expectation_id = ${String(src[0].id)}::UUID
    `;
    await sql`DELETE FROM supplier_expectations WHERE id = ${String(src[0].id)}::UUID AND company_id = ${companyId}::UUID`;
  }
  // An open alert for a date the survivor already has one for is a duplicate: dropped; the others move.
  await sql`
    DELETE FROM expected_invoice_alerts a
     WHERE a.company_id = ${companyId}::UUID AND a.supplier_id = ${sourceId}::UUID AND a.status IN ('pending', 'chased')
       AND EXISTS (SELECT 1 FROM expected_invoice_alerts t
                    WHERE t.company_id = a.company_id AND t.supplier_id = ${targetId}::UUID AND t.expected_by = a.expected_by)
  `;
  const alerts = (await sql`
    UPDATE expected_invoice_alerts SET supplier_id = ${targetId}::UUID, updated_at = NOW()
     WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID AND status IN ('pending', 'chased')
     RETURNING id
  `) as DbRow[];
  return moved + alerts.length;
}
