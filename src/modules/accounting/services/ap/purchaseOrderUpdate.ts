/**
 * update_purchase_order (design docs/design/mcp-po-maintenance.md, decision 1). Header fields and, optionally, ALL lines are
 * replaced on a draft, submitted or APPROVED purchase order; totals come from the lines. Posts nothing.
 *
 * Order, all in one savepoint (a refusal anywhere leaves nothing): the budget gate FIRST (an APPROVED PO under the block policy:
 * the approve paths' first lock) -> the PO row `FOR UPDATE` (5 s, `PURCHASE_ORDER_LOCK_TIMEOUT`) -> the receipt / bill-link
 * refusal (`purchaseOrderMaintenanceGuards`: replacing lines would orphan them) -> the writes -> for an APPROVED PO whose lines or
 * order date changed, the Approve action's budget check on the NEW lines (`checkPurchaseOrderBudget`, channel mcp, gate held): a
 * block throws `BudgetExceededError` and the savepoint takes the edit with it; a warn comes back as `budgetWarnings`. A draft /
 * submitted PO commits nothing and is not checked. The status is read before the gate to decide whether to take it; under the
 * row lock a changed status is `PurchaseOrderChangedError` (a draft approved meanwhile would need the gate AFTER the row).
 *
 * Editing an APPROVED PO is OWNER / ADMIN only (`mayEditApproved`, Hein's R1 as for closing: an edit changes what the PO commits),
 * refused at the first status read, before the gate, the lock or any write. The edit RESTAMPS approved_by / approved_at to the
 * editor (they approved what it now says); the previous approver and time are kept in the audit row (`prior_approved_by` /
 * `prior_approved_at`). Under the BLOCK policy every replacement line needs an expense account: a line with none cannot meet a
 * budget, so it would escape the check the edit exists to re-run. The check judges the PO's NEW lines in the order date's (new)
 * month; the month the PO leaves only loses commitment, which cannot put anything over.
 * The caller (`purchaseOrderUpdatePrepare`) has validated and priced everything; this writes it.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { withRowLockBudget } from '../core/rowLockBudget';
import { openBudgetGate } from '../budgets/budgetCheck';
import type { BudgetGate } from '../budgets/budgetCheckTypes';
import { checkPurchaseOrderBudget } from './purchaseOrderBudget';
import {
  PurchaseOrderChangedError, PurchaseOrderLockTimeoutError, PurchaseOrderMaintenanceRefusal, PurchaseOrderNotFoundError,
} from './purchaseOrderErrors';
import { insertPoLines, type PoLineRow } from './purchaseOrderLinesWrite';
import { ACCOUNTLESS_REFUSAL, receiptOrLinkRefusal } from './purchaseOrderMaintenanceGuards';
import type { PoCents } from './purchaseOrderImportAmounts';

/** The statuses an update accepts: the PUT's (draft, submitted) and approved. */
export const APPROVED_EDIT_REFUSAL = 'Editing an approved purchase order changes what it commits, which only an owner or admin may do';

export const UPDATABLE_PO_STATUSES: readonly string[] = ['draft', 'submitted', 'approved'];

export interface PoUpdateRequest {
  poId: string;
  /** undefined = unchanged; for the three nullable fields null clears. */
  header: { supplierId?: string; orderDate?: string; deliveryDate?: string | null; reference?: string | null; notes?: string | null };
  /** null = lines and totals unchanged. */
  replace: { lines: readonly PoLineRow[]; totals: PoCents } | null;
}

export interface PoUpdateOptions { userId: string; via: string; budgetFigures: boolean; /** Owner / admin: may edit an APPROVED PO. */ mayEditApproved?: boolean }

export interface PoUpdateResult {
  poId: string;
  poNumber: string;
  status: string;
  changedFields: string[];
  linesReplaced: number | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  budgetChecked: boolean;
  budgetWarnings: string[];
}

const r2 = (c: number) => c / 100;
const has = (v: unknown) => v !== undefined;
const text = (v: unknown): string | null => (v == null ? null : String(v));

async function lockFull(companyId: string, poId: string): Promise<DbRow | undefined> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT po_number, status, supplier_id::TEXT AS supplier_id, to_char(order_date, 'YYYY-MM-DD') AS order_date,
           to_char(expected_delivery_date, 'YYYY-MM-DD') AS delivery_date, reference, notes,
           subtotal::TEXT AS subtotal, tax_amount::TEXT AS tax_amount, total::TEXT AS total, approved_by, approved_at::TEXT AS approved_at
      FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID
       FOR UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError());
  return rows[0];
}

const PRIOR_LINES_SHOWN = 20;

async function priorLinesForAudit(poId: string): Promise<{ text: string; total: number }> {
  const rows = (await sql`
    SELECT gl_account_id::TEXT AS a, cc1_id::TEXT AS c1, cc2_id::TEXT AS c2, bu_id::TEXT AS bu, quantity::TEXT AS q, line_total::TEXT AS t
      FROM po_items WHERE purchase_order_id = ${poId}::UUID ORDER BY sort_order, id
  `) as DbRow[];
  const shown = rows.slice(0, PRIOR_LINES_SHOWN).map((r) => ({ account: r.a, cc1: r.c1, cc2: r.c2, bu: r.bu, qty: r.q, amount: r.t }));
  return { text: JSON.stringify(shown), total: rows.length };
}

export async function updatePurchaseOrder(companyId: string, req: PoUpdateRequest, opts: PoUpdateOptions): Promise<PoUpdateResult> {
  const { poId, header, replace } = req;
  const seen = (await sql`SELECT status FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (!seen[0]) throw new PurchaseOrderNotFoundError();
  if (seen[0].status === 'approved' && opts.mayEditApproved !== true) throw new PurchaseOrderMaintenanceRefusal(APPROVED_EDIT_REFUSAL);

  return withSavepoint('update_purchase_order', async () => {
    const gate: BudgetGate | null = seen[0]!.status === 'approved' ? await openBudgetGate(companyId, 'take') : null;
    const po = await lockFull(companyId, poId);
    if (!po) throw new PurchaseOrderNotFoundError();
    const status = String(po.status);
    if (status !== String(seen[0]!.status)) throw new PurchaseOrderChangedError();
    if (!UPDATABLE_PO_STATUSES.includes(status)) {
      throw new PurchaseOrderMaintenanceRefusal(`Only a draft, submitted or approved purchase order can be edited (this one is ${status.replace(/_/g, ' ')})`);
    }
    if (status === 'approved' && opts.mayEditApproved !== true) throw new PurchaseOrderMaintenanceRefusal(APPROVED_EDIT_REFUSAL);
    const refusal = await receiptOrLinkRefusal(companyId, poId, 'its lines and header cannot be edited');
    if (refusal) throw new PurchaseOrderMaintenanceRefusal(refusal);
    if (status === 'approved' && gate?.policy === 'block' && replace?.lines.some((l) => l.glAccountId === null)) {
      throw new PurchaseOrderMaintenanceRefusal(ACCOUNTLESS_REFUSAL);
    }

    // What an approved PO's line replacement removes, for the audit row (account, dimensions, quantity, ex-VAT amount; capped).
    const prior = status === 'approved' && replace ? await priorLinesForAudit(poId) : null;
    const newDate = header.orderDate ?? String(po.order_date);
    const updated = (await sql`
      UPDATE purchase_orders SET
        supplier_id            = COALESCE(${header.supplierId ?? null}::UUID, supplier_id),
        order_date             = COALESCE(${header.orderDate ?? null}::DATE, order_date),
        expected_delivery_date = CASE WHEN ${has(header.deliveryDate)}::BOOLEAN THEN ${header.deliveryDate ?? null}::DATE ELSE expected_delivery_date END,
        reference              = CASE WHEN ${has(header.reference)}::BOOLEAN THEN ${header.reference ?? null}::TEXT ELSE reference END,
        notes                  = CASE WHEN ${has(header.notes)}::BOOLEAN THEN ${header.notes ?? null}::TEXT ELSE notes END,
        subtotal               = COALESCE(${replace ? r2(replace.totals.subtotal) : null}::NUMERIC, subtotal),
        tax_amount             = COALESCE(${replace ? r2(replace.totals.tax) : null}::NUMERIC, tax_amount),
        total                  = COALESCE(${replace ? r2(replace.totals.total) : null}::NUMERIC, total),
        approved_by            = CASE WHEN ${status === 'approved'}::BOOLEAN THEN ${opts.userId}::TEXT ELSE approved_by END,
        approved_at            = CASE WHEN ${status === 'approved'}::BOOLEAN THEN NOW() ELSE approved_at END,
        updated_at = NOW(), updated_by = ${opts.userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status = ${status}
      RETURNING subtotal::TEXT AS subtotal, tax_amount::TEXT AS tax_amount, total::TEXT AS total
    `) as DbRow[];
    if (!updated[0]) throw new PurchaseOrderChangedError();
    if (replace) {
      // The parent row is held and company-checked above: these are this company's lines (po_items has no company_id).
      await sql`DELETE FROM po_items WHERE purchase_order_id = ${poId}::UUID`;
      await insertPoLines(poId, replace.lines);
    }

    const changed: string[] = [];
    const fields: { field: string; old: string | null; new: string | null; label: string }[] = [];
    const note = (field: string, label: string, before: unknown, after: unknown) => {
      if (text(before) !== text(after)) { changed.push(field); fields.push({ field, old: text(before), new: text(after), label }); }
    };
    if (has(header.supplierId)) note('supplier_id', 'Supplier', po.supplier_id, header.supplierId);
    if (has(header.orderDate)) note('order_date', 'Order date', po.order_date, header.orderDate);
    if (has(header.deliveryDate)) note('expected_delivery_date', 'Delivery date', po.delivery_date, header.deliveryDate);
    if (has(header.reference)) note('reference', 'Reference', po.reference, header.reference);
    if (has(header.notes)) note('notes', 'Notes', po.notes, header.notes);
    if (replace) {
      changed.push('lines');
      note('total', 'Total', po.total, updated[0].total);
    }

    // An approved PO commits its open lines: the edit may raise that, so the Approve action's check judges the NEW lines (the
    // month is the order date's). Lines replaced or the month moved; a notes edit commits nothing new.
    let budgetWarnings: string[] = [];
    let budgetChecked = false;
    if (status === 'approved' && gate && (replace || newDate.slice(0, 7) !== String(po.order_date).slice(0, 7))) {
      const check = await checkPurchaseOrderBudget(
        companyId, { id: poId, poNumber: String(po.po_number), status, month: newDate.slice(0, 7) }, gate,
        { channel: 'mcp', lock: 'held', gate, figures: opts.budgetFigures }, opts.userId,
      );
      budgetWarnings = check.warnings;
      budgetChecked = check.policy !== 'off';
    }

    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: poId, entityRef: String(po.po_number).slice(0, 100),
      changes: {
        fields,
        metadata: {
          source: opts.via, status, changed: changed.join(',').slice(0, 200),
          ...(replace ? { lines: String(replace.lines.length), subtotal: String(updated[0].subtotal), total: String(updated[0].total) } : {}),
          ...(prior ? { prior_lines: prior.text, prior_lines_total: String(prior.total) } : {}),
          ...(status === 'approved' ? { prior_approved_by: String(po.approved_by ?? ''), prior_approved_at: String(po.approved_at ?? ''), budgetChecked: String(budgetChecked), ...(budgetWarnings.length > 0 ? { budgetWarnings: String(budgetWarnings.length) } : {}) } : {}),
        },
      },
    });
    return {
      poId, poNumber: String(po.po_number), status, changedFields: changed, linesReplaced: replace ? replace.lines.length : null,
      subtotal: Number(updated[0].subtotal), taxAmount: Number(updated[0].tax_amount), total: Number(updated[0].total), budgetChecked, budgetWarnings,
    };
  });
}
