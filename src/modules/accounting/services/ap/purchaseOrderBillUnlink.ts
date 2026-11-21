/**
 * unlink_bill_from_purchase_order (design decision 10, Hein's rulings R1 / R2, 19 Nov). Posts nothing.
 *
 * Lock order (re-census in the design note): the company budget gate (`openBudgetGate`: the block policy's advisory lock,
 * the approve paths' FIRST lock; warn / off take none) -> the PO row -> the bill rows (this bill and the bills of the
 * PO's other links, one sorted list), one 5 s `withRowLockBudget` deadline for the two row sections.
 *
 * THE ONE EXIT for every kind of tie (design mcp-po-maintenance.md): the PO maintenance tools refuse "unlink it first" for a link row,
 * a bill line naming one of the PO's lines (a R0 line, a draft or cancelled bill's line, legacy data: none of which has a link row)
 * and a bill naming the PO in its header. So the call succeeds when ANY of the three references exists, in one locked write: the
 * link row (if present), `po_item_id` on the bill's lines into this PO, and the header if it names this PO. It refuses "not linked"
 * only when none does. Any bill status (draft, cancelled, soft-deleted too): these are references only, nothing posted reads them
 * (committed / billed read approved / paid / partially_paid bills' lines; clearing such a bill's non-zero line reference RAISES committed
 * spend, so it is gated and warned like any unlink; since PR #1703 so does clearing an approved bill's HEADER when it netted the PO
 * (`budgets/billAttribution`); a draft / cancelled / deleted / R0 bill's reference changes no figure and warns nothing; the bill's stored
 * three-way state is re-judged or reset, `purchaseOrderUnlinkClear`). Lock order is unchanged.
 *
 * Then: delete the link, clear `po_item_id` on the bill's lines into this PO, reset the bill's header
 * (`purchaseOrderBillLinkHeader`), and decide the PO's status:
 *   - the PO is closed BY BILLING (`purchase_orders.closed_by_billing`, set (column: 1016) by a link call's close_when_fully_billed or by 1022's close step, with
 *     closed_from_status; PR #1703 breaker R4-1), the removed tie counted (billed fell: a link, line or header reference of an
 *     approved / paid / partially_paid live bill, review r4 L2) and the PO is no longer fully billed (what those bills hold on it by
 *     `budgets/billAttribution` < subtotal - 1 c) -> it reopens to closed_from_status and both columns clear
 *     (`purchaseOrderBillingClose.reopenUnderBilled`, the rule a bill cancel and soft delete use too);
 *   - otherwise the status stays: a PO closed by hand, or cancelled, is never touched, and a PO still fully billed keeps its record
 *     on itself (no link holds it, so none is lost with a link).
 * R2: when the PO commits spend again (it reopened, or its lines are un-netted) the budget is READ (`unlinkBudgetWarnings`: the same lines
 * the PO approve judges, nothing recorded) and an over-budget result comes back as `budgetWarnings` in the unlink's own wording; it
 * NEVER blocks and never fails on a busy gate or a policy that changed. Reopening is open to any write:invoices holder (Hein): it
 * restores a commitment, the conservative direction.
 * A reason is required; audited. A cancelled or soft-deleted bill can still be unlinked (clean-up).
 */
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { RowLockTimeoutError, ROW_LOCK_BUDGET_MS, withRowLockBudget } from '../core/rowLockBudget';
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { openBudgetGate } from '../budgets/budgetCheck';
import { BudgetCheckLockTimeoutError } from '../budgets/budgetCheckTypes';
import { billedCentsByPo } from './purchaseOrderBilled';
import { syncBillHeaderPurchaseOrder } from './purchaseOrderBillLinkHeader';
import { unlinkBudgetWarnings } from './purchaseOrderUnlinkBudget';
import { PurchaseOrderLockTimeoutError } from './purchaseOrderErrors';
import { auditBillCleared, resetMatchState } from './purchaseOrderUnlinkClear';
import { PurchaseOrderBillLinkRefusal } from './purchaseOrderBillLinkTypes';
import { isFullyBilledBasis } from '../budgets/poCommitStatus';
import { poCommittedCents, reopenUnderBilled } from './purchaseOrderBillingClose';
import { BILLED_STATUSES, poBillingBasisCents } from '../budgets/remainingCommitted';
import { billTies } from '../budgets/billAttribution';

export interface UnlinkRequest { poId: string | null; poNumber: string | null; billId: string; reason: string }

export interface UnlinkOptions { userId: string; via: string; /** May budget warnings show figures (read:reports). */ budgetFigures: boolean }

export interface UnlinkResult {
  poId: string;
  poNumber: string;
  billId: string;
  invoiceNumber: string;
  /** Null when the bill had no link row (only line or header references). */
  linkId: string | null;
  amountCents: number;
  /** The bill's header named this PO and no longer does. */
  headerCleared: boolean;
  linesCleared: number;
  poStatusBefore: string;
  poStatusAfter: string;
  reopenedTo: string | null;
  /** Billed after the unlink, and whether that still covers the PO (cents). */
  billedCents: number;
  fullyBilled: boolean;
  budgetWarnings: string[];
}

const NOT_FOUND = (what: string) => new PurchaseOrderBillLinkRefusal(`${what} not found`);

export async function unlinkBillFromPurchaseOrder(companyId: string, req: UnlinkRequest, opts: UnlinkOptions): Promise<UnlinkResult> {
  const reason = req.reason.trim();
  if (reason === '') throw new PurchaseOrderBillLinkRefusal('Give a reason to unlink a bill from a purchase order');
  const resolved = (await sql`
    SELECT id::TEXT AS id FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND (id = ${req.poId}::UUID OR po_number = ${req.poNumber}::TEXT)
  `) as DbRow[];
  if (resolved.length !== 1) throw NOT_FOUND('Purchase order');
  const poId = String(resolved[0]!.id);

  // FIRST, as every budget-checked writer. Its own savepoint: a busy gate (BudgetCheckLockTimeoutError, a 55P03) must not abort the
  // request. R2: an unlink never blocks on the budget, so a busy gate only means the budget is not checked this time.
  let gateBusy = false;
  try { await withSavepoint('unlink_budget_gate', () => openBudgetGate(companyId, 'take')); } catch (err) {
    if (!(err instanceof BudgetCheckLockTimeoutError)) throw err;
    gateBusy = true;
  }
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  const pos = await withRowLockBudget(async () => (await sql`
    SELECT po_number, status, to_char(order_date, 'YYYY-MM') AS month FROM purchase_orders
     WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID FOR NO KEY UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError(), { deadline }); // not FOR UPDATE: see purchaseOrderBillLinkRead (draft edit vs link deadlock)
  if (!pos[0]) throw NOT_FOUND('Purchase order');
  const held = (await sql`
    SELECT supplier_invoice_id::TEXT AS bill FROM purchase_order_bill_links
     WHERE company_id = ${companyId}::UUID AND purchase_order_id = ${poId}::UUID
  `) as DbRow[];
  const lockIds = [...new Set([req.billId, ...held.map((r) => String(r.bill).toLowerCase())])].sort();
  const bills = (await withRowLockBudget(async () => (await sql`
    SELECT id::TEXT AS id, invoice_number, status, purchase_order_id::TEXT AS po FROM supplier_invoices
     WHERE company_id = ${companyId}::UUID AND id = ANY(${lockIds}::UUID[]) ORDER BY id FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('The bill'), { deadline })).filter((b) => String(b.id).toLowerCase() === req.billId);
  if (!bills[0]) throw NOT_FOUND('Purchase order or bill');
  const poNumber = String(pos[0].po_number);
  const status = String(pos[0].status);
  const invoiceNumber = String(bills[0].invoice_number);

  const all = (await sql`
    SELECT l.id::TEXT AS id, l.supplier_invoice_id::TEXT AS bill, l.amount
      FROM purchase_order_bill_links l JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
     WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ${poId}::UUID ORDER BY l.created_at, l.id
  `) as DbRow[];
  const link = all.find((l) => String(l.bill).toLowerCase() === req.billId);
  const namesInHeader = bills[0].po != null && String(bills[0].po).toLowerCase() === poId;
  const lineRefs = (await sql`
    SELECT 1 FROM supplier_invoice_items sii JOIN po_items pi ON pi.id = sii.po_item_id AND pi.purchase_order_id = ${poId}::UUID
     WHERE sii.supplier_invoice_id = ${req.billId}::UUID LIMIT 1
  `) as DbRow[];
  if (!link && lineRefs.length === 0 && !namesInHeader) {
    throw new PurchaseOrderBillLinkRefusal(`Bill ${invoiceNumber} is not linked to purchase order ${poNumber} (no link, no line on one of its lines, and its header does not name it)`);
  }
  // What the PO is billed before anything is cleared (under its lock): a reopen needs the removed tie to have counted (review r4 L2).
  const billedBefore = (await billedCentsByPo(companyId, [poId])).get(poId) ?? 0;

  // Breaker r6 A3: whether the unlink raises committed is measured, best effort: what the PO commits by the committed engine itself
  // (poCommittedCents), read before the clear and after the reopen, computed under the PO lock; concurrent changes to other bills can
  // make it noisy (review r7 M3; no lock is added for it).
  const committedBefore = (await poCommittedCents(companyId, [poId])).get(poId) ?? 0;
  // Breaker B7-4: and only a tie that COUNTED can raise it: this bill billed, live and attributed > 0 to this PO (the per-(bill, PO)
  // floor, budgets/billAttribution), so a concurrent cancel of another bill is never blamed on the unlink of a draft.
  const tieCounted = (await billTies(companyId, [poId], { statuses: BILLED_STATUSES }))
    .some((t) => t.billId === req.billId && !t.deleted && t.cents > 0);
  const cleared = (await sql`
    UPDATE supplier_invoice_items sii SET po_item_id = NULL
      FROM po_items pi
     WHERE sii.supplier_invoice_id = ${req.billId}::UUID AND pi.id = sii.po_item_id AND pi.purchase_order_id = ${poId}::UUID
       AND EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID)
    RETURNING sii.id
  `) as DbRow[];
  if (link) await sql`DELETE FROM purchase_order_bill_links WHERE id = ${String(link.id)}::UUID AND company_id = ${companyId}::UUID`;
  await syncBillHeaderPurchaseOrder(companyId, [req.billId], poId);
  const headerAfter = (await sql`SELECT purchase_order_id::TEXT AS po FROM supplier_invoices WHERE id = ${req.billId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const headerCleared = namesInHeader && String(headerAfter[0]?.po ?? '').toLowerCase() !== poId;

  // The bill's stored three-way state no longer matches what it names: re-judged, or reset when it names no PO.
  const matchState = cleared.length > 0 || headerCleared ? await resetMatchState(companyId, req.billId) : 'unchanged';

  const billed = (await billedCentsByPo(companyId, [poId])).get(poId) ?? 0;
  const fully = isFullyBilledBasis(billed, (await poBillingBasisCents(companyId, [poId])).get(poId) ?? 0); // never on a basis of 0
  // Removing ANY counted tie (link, lines, header of a billed live bill) reopens a PO closed BY BILLING (purchase_orders.closed_by_billing,
  // PR #1703 breaker R4-1) once it is no longer fully billed; a PO closed by hand, or a tie that never counted, is not touched.
  const reopenedTo = (await reopenUnderBilled(companyId, new Map([[poId, billedBefore]]), {
    userId: opts.userId, via: opts.via, why: reason, audit: false,
  })).get(poId)?.reopenedTo ?? null;
  const statusAfter = reopenedTo ?? status;
  const raisesCommitted = tieCounted && ((await poCommittedCents(companyId, [poId])).get(poId) ?? 0) > committedBefore;

  // R2 (Hein): never blocks, and records nothing (no budget_check_events row, no approve audit row): a READ of what the PO would
  // now commit, worded for an unlink. Not run when the budget gate was busy; the reply says so.
  let budgetWarnings: string[] = [];
  // Only when its committed really rose (a PO closed by billing that stays closed is measured the same way, breaker r5 / r6 A3).
  if (raisesCommitted && gateBusy) {
    budgetWarnings = ['The budget could not be checked just now (another approval holds the budget lock); the purchase order commits spend again, check it in the app.'];
  } else if (raisesCommitted) {
    // Its own savepoint (review r7 H1): a SQL error in the read is said and logged, and cannot abort the unlink's transaction.
    try {
      budgetWarnings = await withSavepoint('unlink_budget_read', () => unlinkBudgetWarnings(companyId, poId, poNumber, opts.budgetFigures));
    } catch (err) {
      log.warn('Unlink budget read failed', { companyId, poId, error: err instanceof Error ? err.message : String(err) }, 'accounting');
      budgetWarnings = ['The budget could not be checked just now; the purchase order commits spend again, check it in the app.'];
    }
  }

  await logAuditOrThrow({
    companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: poId, entityRef: poNumber.slice(0, 100),
    changes: {
      fields: reopenedTo ? [{ field: 'status', old: 'closed', new: reopenedTo, label: 'Status' }] : [],
      metadata: {
        unlinked_bill: invoiceNumber.slice(0, 100), bill_id: req.billId, link_id: link ? String(link.id) : '', link_removed: String(!!link), amount: link ? Number(link.amount).toFixed(2) : '0.00',
        lines_cleared: String(cleared.length), header_cleared: String(headerCleared), bill_status: String(bills[0].status ?? ''), match_state: matchState, raised_committed: String(raisesCommitted), reason: reason.slice(0, 500), source: opts.via, fully_billed: String(fully),
        ...(budgetWarnings.length > 0 ? { budget_warnings: String(budgetWarnings.length) } : {}),
      },
    },
  });
  await auditBillCleared(companyId, opts.userId, req.billId, {
    poNumber, poId, invoiceNumber, linkRemoved: !!link, linesCleared: cleared.length, headerCleared, reason, via: opts.via,
    billStatus: String(bills[0].status ?? ''), match: matchState,
  });
  return {
    poId, poNumber, billId: req.billId, invoiceNumber, linkId: link ? String(link.id) : null, amountCents: link ? Math.round(Number(link.amount) * 100) : 0, headerCleared,
    linesCleared: cleared.length, poStatusBefore: status, poStatusAfter: statusAfter, reopenedTo, billedCents: billed, fullyBilled: fully, budgetWarnings,
  };
}
