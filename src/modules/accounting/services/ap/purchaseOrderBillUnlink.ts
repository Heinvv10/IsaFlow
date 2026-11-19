/**
 * unlink_bill_from_purchase_order (design decision 10, Hein's rulings R1 / R2, 19 Nov). Posts nothing.
 *
 * Lock order (re-census in the design note): the company budget gate (`openBudgetGate`: the block policy's advisory lock,
 * the approve paths' FIRST lock; warn / off take none) -> the PO row -> the bill rows (this bill and the bills of the
 * PO's other links, one sorted list), one 5 s `withRowLockBudget` deadline for the two row sections.
 *
 * Then: delete the link, clear `po_item_id` on the bill's lines into this PO, reset the bill's header
 * (`purchaseOrderBillLinkHeader`), and decide the PO's status:
 *   - the PO is closed and a link of it records the status a link call closed it from (`closed_po_from_status`, read
 *     BEFORE the delete: it may be the deleted link's) and the PO is no longer fully billed (links on approved / paid /
 *     partially_paid bills < subtotal - 1 c) -> it reopens to that status, and the record is cleared;
 *   - still fully billed, and the deleted link held the record -> the record moves to a remaining link of the PO (so a later
 *     unlink can still reopen it);
 *   - a PO closed by hand, or cancelled, is not touched.
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
import { openBudgetGate } from '../budgets/budgetCheck';
import { BudgetCheckLockTimeoutError } from '../budgets/budgetCheckTypes';
import { BILLED_STATUSES, COMMITTING_PO_STATUSES } from '../budgets/remainingCommitted';
import { toCents } from '../budgets/grid/cents';
import { billedCentsByPo } from './purchaseOrderBilled';
import { syncBillHeaderPurchaseOrder } from './purchaseOrderBillLinkHeader';
import { unlinkBudgetWarnings } from './purchaseOrderUnlinkBudget';
import { PurchaseOrderLockTimeoutError } from './purchaseOrderErrors';
import { PurchaseOrderBillLinkRefusal, isFullyBilled } from './purchaseOrderBillLinkTypes';

export interface UnlinkRequest { poId: string | null; poNumber: string | null; billId: string; reason: string }

export interface UnlinkOptions { userId: string; via: string; /** May budget warnings show figures (read:reports). */ budgetFigures: boolean }

export interface UnlinkResult {
  poId: string;
  poNumber: string;
  billId: string;
  invoiceNumber: string;
  linkId: string;
  amountCents: number;
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
    SELECT po_number, status, to_char(order_date, 'YYYY-MM') AS month, subtotal FROM purchase_orders
     WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID FOR NO KEY UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError(), { deadline }); // not FOR UPDATE: see purchaseOrderBillLinkRead (draft edit vs link deadlock)
  if (!pos[0]) throw NOT_FOUND('Purchase order');
  const held = (await sql`
    SELECT supplier_invoice_id::TEXT AS bill FROM purchase_order_bill_links
     WHERE company_id = ${companyId}::UUID AND purchase_order_id = ${poId}::UUID
  `) as DbRow[];
  const lockIds = [...new Set([req.billId, ...held.map((r) => String(r.bill).toLowerCase())])].sort();
  const bills = (await withRowLockBudget(async () => (await sql`
    SELECT id::TEXT AS id, invoice_number FROM supplier_invoices
     WHERE company_id = ${companyId}::UUID AND id = ANY(${lockIds}::UUID[]) ORDER BY id FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('The bill'), { deadline })).filter((b) => String(b.id).toLowerCase() === req.billId);
  if (!bills[0]) throw NOT_FOUND('Purchase order or bill');
  const poNumber = String(pos[0].po_number);
  const status = String(pos[0].status);
  const invoiceNumber = String(bills[0].invoice_number);

  const all = (await sql`
    SELECT l.id::TEXT AS id, l.supplier_invoice_id::TEXT AS bill, l.amount, l.closed_po_from_status,
           (si.status = ANY(${[...BILLED_STATUSES]}::TEXT[]) AND si.deleted_at IS NULL) AS billed,
           NOT (l.source IN ('app', 'backfill') AND l.external_ref IS NULL) AS durable
      FROM purchase_order_bill_links l JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
     WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ${poId}::UUID ORDER BY l.created_at, l.id
  `) as DbRow[];
  const link = all.find((l) => String(l.bill).toLowerCase() === req.billId);
  if (!link) throw new PurchaseOrderBillLinkRefusal(`Bill ${invoiceNumber} is not linked to purchase order ${poNumber}`);
  const claim = all.find((l) => l.closed_po_from_status != null);
  const closedFrom = claim ? String(claim.closed_po_from_status) : null;

  const cleared = (await sql`
    UPDATE supplier_invoice_items sii SET po_item_id = NULL
      FROM po_items pi
     WHERE sii.supplier_invoice_id = ${req.billId}::UUID AND pi.id = sii.po_item_id AND pi.purchase_order_id = ${poId}::UUID
       AND EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID)
    RETURNING sii.id
  `) as DbRow[];
  await sql`DELETE FROM purchase_order_bill_links WHERE id = ${String(link.id)}::UUID AND company_id = ${companyId}::UUID`;
  await syncBillHeaderPurchaseOrder(companyId, [req.billId], poId);

  const billed = (await billedCentsByPo(companyId, [poId])).get(poId) ?? 0;
  const fully = isFullyBilled(billed, toCents(Number(pos[0].subtotal ?? 0)));
  let statusAfter = status;
  let reopenedTo: string | null = null;
  if (status === 'closed' && closedFrom && !fully) {
    const back = (await sql`
      UPDATE purchase_orders SET status = ${closedFrom}, updated_at = NOW(), updated_by = ${opts.userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status = 'closed' RETURNING id
    `) as DbRow[];
    if (back.length !== 1) throw new Error('The purchase order changed while it was being reopened');
    reopenedTo = closedFrom;
    statusAfter = closedFrom;
    if (claim && String(claim.id) !== String(link.id)) {
      await sql`UPDATE purchase_order_bill_links SET closed_po_from_status = NULL WHERE id = ${String(claim.id)}::UUID AND company_id = ${companyId}::UUID`;
    }
  } else if (status === 'closed' && claim && String(claim.id) === String(link.id)) {
    // Still fully billed: the closing record outlives the link that held it.
    // Only a link on a BILLED bill can hold it (a draft's app link is remade by the draft's next edit), the durable (mcp / referenced) first.
    const others = all.filter((l) => String(l.id) !== String(link.id) && l.billed === true);
    const heir = others.find((l) => l.durable === true) ?? others[0];
    if (heir) {
      await sql`UPDATE purchase_order_bill_links SET closed_po_from_status = ${closedFrom} WHERE id = ${String(heir.id)}::UUID AND company_id = ${companyId}::UUID`;
    }
  }

  // R2 (Hein): never blocks, and records nothing (no budget_check_events row, no approve audit row): a READ of what the PO would
  // now commit, worded for an unlink. Not run when the budget gate was busy; the reply says so.
  let budgetWarnings: string[] = [];
  if ((COMMITTING_PO_STATUSES as readonly string[]).includes(statusAfter) && (reopenedTo !== null || cleared.length > 0)) {
    budgetWarnings = gateBusy
      ? ['The budget could not be checked just now (another approval holds the budget lock); the purchase order commits spend again, check it in the app.']
      : await unlinkBudgetWarnings(companyId, poId, poNumber, opts.budgetFigures);
  }

  await logAuditOrThrow({
    companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: poId, entityRef: poNumber.slice(0, 100),
    changes: {
      fields: reopenedTo ? [{ field: 'status', old: 'closed', new: reopenedTo, label: 'Status' }] : [],
      metadata: {
        unlinked_bill: invoiceNumber.slice(0, 100), bill_id: req.billId, link_id: String(link.id), amount: Number(link.amount).toFixed(2),
        lines_cleared: String(cleared.length), reason: reason.slice(0, 500), source: opts.via, fully_billed: String(fully),
        ...(budgetWarnings.length > 0 ? { budget_warnings: String(budgetWarnings.length) } : {}),
      },
    },
  });
  return {
    poId, poNumber, billId: req.billId, invoiceNumber, linkId: String(link.id), amountCents: Math.round(Number(link.amount) * 100),
    linesCleared: cleared.length, poStatusBefore: status, poStatusAfter: statusAfter, reopenedTo, billedCents: billed, fullyBilled: fully, budgetWarnings,
  };
}
