/**
 * "Closed because fully billed" (PR #1703, ledger breaker r4 R4-1): the record lives on the purchase order itself,
 * `purchase_orders.closed_by_billing` beside `closed_from_status` (migration 1016), never on a link. Only the link tool's
 * close_when_fully_billed and 1022's close step set it; a manual short close (close_purchase_order) and set_purchase_order_status
 * leave it false, and 1016's trigger clears it whenever the status leaves closed, whoever writes that.
 *
 * Correctness does not depend on the reopen (breaker r5): a PO closed by billing still counts in committed at its open remainder
 * (`budgets/remainingCommitted.commitsSpend`), so a path that under-bills it without reopening it (a race, a lines link) commits the
 * unbilled rands anyway. The reopen fixes the STATUS.
 *
 * The one rule (`isClosedUnderBilled`, also get_purchase_order's closed_under_billed): closed, closed_by_billing, and no longer
 * fully billed (`purchaseOrderBilled.billedCentsByPo` < the billing basis - 1 c: max(header subtotal, lines' total),
 * `remainingCommitted.poBillingBasisCents`, as 1022 closes on; review r7 M2). `reopenUnderBilled` re-judges POs after a counted tie
 * went (billed fell: the unlink of a billed live bill's link / lines / header, a bill cancelled or soft-deleted) and reopens each
 * to closed_from_status (as the PO row holds it now: a goods-received cancel's recomputation is honoured), clearing both columns,
 * with a log line and an audit row. A PO whose billed did not fall is never reopened: removing a tie that never counted (a draft or
 * cancelled bill's) leaves a PO closed under-billed as it was (review r4 L2). `billedBefore` is read under the caller's PO lock
 * before the change; a concurrent change that lowers billed without that lock can only make "billed fell" more likely, so the
 * comparison errs toward reopening, the conservative direction (committed rises; review r5 L4).
 *
 * Lock order: the caller holds the PO rows (FOR NO KEY UPDATE) BEFORE any bill row, as the link and unlink do:
 * `lockPosClosedByBilling` is that step for the bill cancel, the bill soft delete and the bulk cancel (all its bills at once, before
 * the first; PO -> bill, the census in docs/design/mcp-po-bill-links.md).
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { toCents } from '../budgets/grid/cents';
import { openPoLineCents } from '../budgets/remainingBudgetCore';
import { commitsSpend, committedBillingByPoItem, fullyBilledClosedPos, poBillingBasisCents } from '../budgets/remainingCommitted';
import { billedCentsByPo } from './purchaseOrderBilled';
import { isFullyBilledBasis } from '../budgets/poCommitStatus';
import { billTies } from '../budgets/billAttribution';
import { BILLED_STATUSES } from '../budgets/poCommitStatus';
import { unlinkBudgetWarnings } from './purchaseOrderUnlinkBudget';

export interface ReopenedPo { poId: string; poNumber: string; reopenedTo: string }

/** The one rule: a PO closed because it was fully billed that no longer is. */
export function isClosedUnderBilled(po: { status: string; closedByBilling: boolean; subtotalCents: number }, billedCents: number): boolean {
  return po.status === 'closed' && po.closedByBilling && !isFullyBilledBasis(billedCents, po.subtotalCents);
}

/**
 * The POs closed by billing that these bills tie (a link, a header, a line naming one of their lines), locked FOR NO KEY UPDATE in id
 * order, and what each is billed now: taken BEFORE any of the bills is locked (PO -> bill). A tie written after this read is on a PO
 * this call does not re-judge; its own writer (the link) locked that PO first.
 */
export async function lockPosClosedByBilling(companyId: string, billIds: string | readonly string[]): Promise<Map<string, number>> {
  const ids = typeof billIds === 'string' ? [billIds] : [...billIds];
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT po.id::TEXT AS id FROM purchase_orders po
     WHERE po.company_id = ${companyId}::UUID AND po.status = 'closed' AND po.closed_by_billing AND po.id IN (
         SELECT l.purchase_order_id FROM purchase_order_bill_links l WHERE l.company_id = ${companyId}::UUID AND l.supplier_invoice_id = ANY(${ids}::UUID[])
         UNION SELECT si.purchase_order_id FROM supplier_invoices si WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${ids}::UUID[])
         UNION SELECT pi.purchase_order_id FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id WHERE x.supplier_invoice_id = ANY(${ids}::UUID[]))
     ORDER BY po.id FOR NO KEY UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('A purchase order of this bill'));
  const poIds = rows.map((r) => String(r.id).toLowerCase());
  const billed = await billedCentsByPo(companyId, poIds);
  return new Map(poIds.map((id) => [id, billed.get(id) ?? 0]));
}

/**
 * After the bill itself is locked (Codex gate): a link call that closed one of its POs by billing while this call waited on the bill
 * was invisible to `lockPosClosedByBilling`'s read. Re-read; lock each new PO (FOR NO KEY UPDATE, in its own savepoint, under the
 * row-lock budget) and read what it is billed before the change. A lock that times out (or a deadlock) leaves that PO as it is,
 * logged: committed still counts a PO closed by billing at its remainder (`remainingCommitted.commitsSpend`), so no figure is lost.
 */
export async function lockLateClosedByBilling(companyId: string, billId: string, known: ReadonlyMap<string, number>): Promise<Map<string, number>> {
  const out = new Map(known);
  const now = ((await sql`
    SELECT po.id::TEXT AS id FROM purchase_orders po
     WHERE po.company_id = ${companyId}::UUID AND po.status = 'closed' AND po.closed_by_billing AND po.id IN (
         SELECT l.purchase_order_id FROM purchase_order_bill_links l WHERE l.company_id = ${companyId}::UUID AND l.supplier_invoice_id = ANY(${[billId]}::UUID[])
         UNION SELECT si.purchase_order_id FROM supplier_invoices si WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${[billId]}::UUID[])
         UNION SELECT pi.purchase_order_id FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id WHERE x.supplier_invoice_id = ANY(${[billId]}::UUID[]))
     ORDER BY po.id
  `) as DbRow[]).map((r) => String(r.id).toLowerCase()).filter((id) => !known.has(id));
  for (const id of now) {
    try {
      await withSavepoint('late_billing_close_lock', () => withRowLockBudget(async () => (await sql`
        SELECT 1 FROM purchase_orders WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR NO KEY UPDATE
      `) as DbRow[], () => new RowLockTimeoutError('A purchase order of this bill')));
      out.set(id, (await billedCentsByPo(companyId, [id])).get(id) ?? 0);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!(err instanceof RowLockTimeoutError) && code !== '40P01' && code !== '55P03') throw err;
      log.warn('A purchase order closed by billing meanwhile could not be locked; left closed', { companyId, billId, poId: id, code }, 'accounting');
    }
  }
  return out;
}

/**
 * Re-judge POs whose billed may have fallen (`billedBefore`: what each was billed before the change, read under the caller's PO lock).
 * Reopens each that is closed by billing, billed less than before, and no longer fully billed. Returns poId -> what it reopened to.
 */
export async function reopenUnderBilled(
  companyId: string, billedBefore: ReadonlyMap<string, number>,
  opts: { userId: string; via: string; why: string; /** false: the caller's own audit row records the reopen (the unlink). */ audit?: boolean },
): Promise<Map<string, ReopenedPo>> {
  const out = new Map<string, ReopenedPo>();
  const ids = [...billedBefore.keys()];
  if (ids.length === 0) return out;
  const pos = (await sql`
    SELECT id::TEXT AS id, po_number, status, closed_by_billing, closed_from_status, subtotal::TEXT AS subtotal FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND status = 'closed' AND closed_by_billing
  `) as DbRow[];
  const billed = await billedCentsByPo(companyId, pos.map((p) => String(p.id).toLowerCase()));
  const basis = await poBillingBasisCents(companyId, pos.map((p) => String(p.id).toLowerCase()));
  for (const p of pos) {
    const id = String(p.id).toLowerCase();
    const now = billed.get(id) ?? 0;
    // Against max(header subtotal, lines' total), as 1022 closed on (review r7 M2).
    const facts = { status: 'closed', closedByBilling: true, subtotalCents: basis.get(id) ?? 0 };
    if (!(now < (billedBefore.get(id) ?? 0)) || !isClosedUnderBilled(facts, now) || p.closed_from_status == null) continue;
    const to = String(p.closed_from_status);
    const back = (await sql`
      UPDATE purchase_orders SET status = ${to}, closed_from_status = NULL, closed_by_billing = false, updated_at = NOW(), updated_by = ${opts.userId}
       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'closed' AND closed_by_billing RETURNING id
    `) as DbRow[];
    if (back.length !== 1) throw new Error('The purchase order changed while it was being reopened');
    out.set(id, { poId: id, poNumber: String(p.po_number), reopenedTo: to });
    log.info('Purchase order reopened: no longer fully billed', { companyId, poId: id, reopenedTo: to, via: opts.via, billedCents: now }, 'accounting');
    if (opts.audit === false) continue;
    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: id, entityRef: String(p.po_number).slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: 'closed', new: to, label: 'Status' }],
        metadata: { reopened: 'true', reason: opts.why.slice(0, 500), source: opts.via, billed: (now / 100).toFixed(2),
          subtotal: (toCents(Number(p.subtotal ?? 0)) / 100).toFixed(2), billing_basis: (facts.subtotalCents / 100).toFixed(2) },
      },
    });
  }
  return out;
}

/** One warning per reopened PO (it commits again), then its budget read (over budget / off-slice lines), as the unlink words them. */
export async function reopenWarnings(companyId: string, reopened: Iterable<ReopenedPo>, figures: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const r of reopened) {
    out.push(`Purchase order ${r.poNumber} reopened to ${r.reopenedTo}: it is no longer fully billed, so it commits spend again.`);
    // Review r6 M3: the reopen is done and stays; a budget read that fails is said, as the unlink says a busy gate, never thrown.
    try {
      // In its own savepoint (review r7 H1): a SQL error inside the read must not abort the request's transaction under a 200.
      out.push(...await withSavepoint('reopen_budget_read', () => unlinkBudgetWarnings(companyId, r.poId, r.poNumber, figures, 'Reopened.')));
    } catch (err) {
      log.warn('Reopen budget read failed', { companyId, poId: r.poId, error: err instanceof Error ? err.message : String(err) }, 'accounting');
      out.push(`The budget could not be checked just now; purchase order ${r.poNumber} commits spend again, check it in the app.`);
    }
  }
  return out;
}

/** What each PO commits now (cents, ex VAT): the same per-line engine as committed; 0 for a PO that commits nothing. */
export async function poCommittedCents(companyId: string, poIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (poIds.length === 0) return out;
  const lines = (await sql`
    SELECT pi.id::TEXT AS id, pi.purchase_order_id::TEXT AS po, pi.line_total::TEXT AS line_total, po.status, po.closed_by_billing
      FROM po_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id = ANY(${[...poIds]}::UUID[])
  `) as DbRow[];
  const billed = await committedBillingByPoItem(companyId, lines.map((l) => String(l.id).toLowerCase()), []);
  // Review r6 M5, as readCommitments: a PO closed by billing that is fully billed at PO level commits 0.
  const settled = await fullyBilledClosedPos(companyId, [...new Set(lines.filter((l) => l.status === 'closed' && l.closed_by_billing === true).map((l) => String(l.po)))]);
  for (const id of poIds) out.set(id.toLowerCase(), 0);
  for (const l of lines) {
    if (!commitsSpend(String(l.status), l.closed_by_billing === true) || settled.has(String(l.po).toLowerCase())) continue;
    const po = String(l.po).toLowerCase();
    out.set(po, (out.get(po) ?? 0) + openPoLineCents(Number(l.line_total), billed.get(String(l.id).toLowerCase()) ?? []));
  }
  return out;
}

export interface BillGoneReopen { reopenedPurchaseOrders: ReopenedPo[]; budgetWarnings: string[] }

/** After a bill is cancelled or soft-deleted (review r5 M1): reopen what it leaves under-billed, and say so, as the unlink does. */
export async function reopenAfterBillGone(
  companyId: string, billedBefore: ReadonlyMap<string, number>, opts: { userId: string; via: string; why: string; figures?: boolean },
): Promise<BillGoneReopen> {
  const reopened = [...(await reopenUnderBilled(companyId, billedBefore, opts)).values()];
  return { reopenedPurchaseOrders: reopened, budgetWarnings: await reopenWarnings(companyId, reopened, opts.figures === true) };
}

/** Review r6 M4, read-only: the POs a cancel or delete of this bill would reopen (its counted tie leaves them under-billed). */
export async function previewReopenOnBillGone(companyId: string, billId: string, billedBefore: ReadonlyMap<string, number>): Promise<ReopenedPo[]> {
  const ids = [...billedBefore.keys()];
  if (ids.length === 0) return [];
  const pos = (await sql`
    SELECT id::TEXT AS id, po_number, closed_from_status FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND status = 'closed' AND closed_by_billing
  `) as DbRow[];
  const basis = await poBillingBasisCents(companyId, ids);
  const held = new Map((await billTies(companyId, ids, { statuses: BILLED_STATUSES }))
    .filter((t) => t.billId === billId.toLowerCase() && !t.deleted).map((t) => [t.poId, t.cents]));
  return pos.filter((p) => {
    const id = String(p.id).toLowerCase();
    const after = (billedBefore.get(id) ?? 0) - (held.get(id) ?? 0);
    return (held.get(id) ?? 0) > 0 && p.closed_from_status != null && !isFullyBilledBasis(after, basis.get(id) ?? 0);
  }).map((p) => ({ poId: String(p.id).toLowerCase(), poNumber: String(p.po_number), reopenedTo: String(p.closed_from_status) }));
}
