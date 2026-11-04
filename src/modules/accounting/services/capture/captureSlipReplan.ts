/**
 * A slip bill's dimensions once its slip is ATTACHED to a bank-first provisional (budgets P5-2b; coordinator's
 * rulings, 2026-11-04: fail closed). Inherited dimensions only ever come from the provisional the bill is attached to.
 *
 * Capture (`replanCaptureSlipDimensions`, run by `provisionalAttachSettle` right after the automatic attach, in the
 * same request transaction): the line plan inherited from the provisional `findAttachableProvisional` READ before the
 * lines were written (`captureBillLines`), and the attach may link another one, or none:
 * - the planned one: nothing to do;
 * - another one: the inherited lines are re-planned from it by the same rule (`inheritSlipDimensions`);
 * - none: the inherited lines take the supplier's defaults, as a line that inherits nothing does at plan time. A
 *   default the dimension rules refuse is the plan's own refusal (same message; the route answers 400 and the request
 *   rolls back, `als.rollbackOnly`), never a 500 (breaker R3-2);
 * - the plan read none (nothing inherited) but the attach linked one: the blank lines inherit from it
 *   (`inheritOnAttach`, the manual attach's rule), the bill still a draft with no approval request bound.
 * Only the inherited lines are re-planned; a line that took the supplier default or nothing keeps it.
 *
 * Manual attach (`inheritOnAttach`, from `provisionalEvidenceAttach`; breaker R3-4): each bill raised from the slip
 * that is a DRAFT with NO approval request bound to it (pending or approved) has its blank lines inherit from the
 * attached provisional; otherwise it is skipped and the attach says so, so no digest moves under a request (migration
 * 873 hashes the lines' dimensions). The capture routes raise their request after the attach, so it holds there too.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { resolveBillLineDimensions } from '../gl/dimensions/supplierDimensionDefaults';
import { DimensionRefusal } from '../gl/dimensions/dimensionTypes';
import { inheritSlipDimensions, provisionalDimLines, type ProvisionalDimLine } from '../ap/supplierInvoiceProvisionalDims';
import { lockSupplierInvoiceForUpdate } from '../ap/supplierInvoiceLock';

/** What the capture plan inherited: the provisional it read, and the bill lines that took its dimensions. */
export interface CaptureSlipPlan {
  plannedJeId: string | null;
  inheritedItemIds: string[];
}

/** One bill's outcome at an attach: how many lines inherited, or why it was skipped. */
export type AttachInheritance = { invoiceId: string; inheritedLines: number } | { invoiceId: string; skipped: string };

interface ItemRow { id: string; glAccountId: string | null; lineTotal: number; cc1Id?: string; cc2Id?: string; buId?: string; costCenterId?: string }
type Header = { subtotal: number; totalAmount: number; taxRate: number; costCenterId: string | null };

const opt = (v: unknown): string | undefined => (v == null ? undefined : String(v));

async function defaultExpenseOrNull(companyId: string): Promise<string | null> {
  try {
    return await getSystemAccountId('default_expense', companyId);
  } catch (err) {
    if (err instanceof MissingSystemAccountError) return null; // no role: a line with no account matches nothing
    throw err;
  }
}

/** The bill's header and every line (with its stored dimensions), company-scoped; null when it is not found. */
async function readBill(companyId: string, invoiceId: string): Promise<{ head: Header; items: ItemRow[] } | null> {
  const [h] = (await sql`
    SELECT subtotal::TEXT AS subtotal, total_amount::TEXT AS total, tax_rate::TEXT AS tax_rate, cost_center_id::TEXT AS cc
      FROM supplier_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!h) return null;
  const rows = (await sql`
    SELECT sii.id::TEXT AS id, sii.gl_account_id::TEXT AS gl_account_id, sii.line_total::TEXT AS line_total,
           sii.cc1_id::TEXT AS cc1_id, sii.cc2_id::TEXT AS cc2_id, sii.bu_id::TEXT AS bu_id, sii.cost_center_id::TEXT AS cost_center_id
      FROM supplier_invoice_items sii JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
     WHERE si.id = ${invoiceId}::UUID AND si.company_id = ${companyId}::UUID
     ORDER BY sii.id
  `) as DbRow[];
  return {
    head: { subtotal: Number(h.subtotal), totalAmount: Number(h.total), taxRate: Number(h.tax_rate), costCenterId: h.cc ? String(h.cc) : null },
    items: rows.map((r) => ({
      id: String(r.id), glAccountId: r.gl_account_id ? String(r.gl_account_id) : null, lineTotal: Number(r.line_total),
      cc1Id: opt(r.cc1_id), cc2Id: opt(r.cc2_id), buId: opt(r.bu_id), costCenterId: opt(r.cost_center_id),
    })),
  };
}

/** The attached provisional's lines (all but its bank line); none when its bank line is gone. */
async function attachedLines(companyId: string, jeId: string): Promise<ProvisionalDimLine[]> {
  const [bank] = (await sql`
    SELECT bank_account_id::TEXT AS bank FROM bank_transactions
     WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  return bank ? provisionalDimLines(companyId, jeId, String(bank.bank)) : [];
}

/** Writes each line's dimensions; the stored line must be what is posted, so a line not found is a fault. */
async function writeDims(companyId: string, invoiceId: string, lines: readonly ItemRow[]): Promise<void> {
  for (const l of lines) {
    const updated = (await sql`
      UPDATE supplier_invoice_items sii
         SET cc1_id = ${l.cc1Id ?? null}::UUID, cc2_id = ${l.cc2Id ?? null}::UUID, bu_id = ${l.buId ?? null}::UUID
        FROM supplier_invoices si
       WHERE sii.id = ${l.id}::UUID AND sii.supplier_invoice_id = si.id AND si.id = ${invoiceId}::UUID
         AND si.company_id = ${companyId}::UUID
      RETURNING sii.id
    `) as DbRow[];
    if (updated.length !== 1) throw new Error(`Slip dimensions: line ${l.id} of supplier invoice ${invoiceId} was not updated`);
  }
}

/**
 * Capture, right after the automatic attach (see the header). Returns null, or the refusal the line plan would give
 * for a supplier default the dimension rules refuse; then the request is marked rollback-only.
 */
export async function replanCaptureSlipDimensions(
  companyId: string, invoiceId: string, supplierId: string, slip: CaptureSlipPlan | undefined, attachedJeId: string | null,
): Promise<string | null> {
  if (!slip) return null;
  if (slip.inheritedItemIds.length === 0) {
    if (attachedJeId) await inheritOnAttach(companyId, invoiceId, attachedJeId);
    return null;
  }
  if (slip.plannedJeId === attachedJeId) return null;
  const bill = await readBill(companyId, invoiceId);
  if (!bill) throw new Error(`Capture slip re-plan: supplier invoice ${invoiceId} not found`);
  const ids = new Set(slip.inheritedItemIds.map((v) => v.toLowerCase()));
  // Only the inherited lines are eligible, read blank again; the others are neither matched nor written.
  const items: ItemRow[] = bill.items.map((i) => ({ id: i.id, glAccountId: i.glAccountId, lineTotal: i.lineTotal }));
  const eligible = items.map((i) => ids.has(i.id.toLowerCase()));
  let planned = items;
  let inherited = items.map(() => false);
  if (attachedJeId) {
    ({ lines: planned, inherited } = await inheritSlipDimensions(companyId, items, bill.head,
      await attachedLines(companyId, attachedJeId), await defaultExpenseOrNull(companyId), eligible));
  }
  // The lines that inherit nothing from the attached provisional take the supplier's defaults.
  let defaulted: ItemRow[];
  try {
    defaulted = await resolveBillLineDimensions(companyId, supplierId, planned.filter((_, i) => eligible[i] && !inherited[i]));
  } catch (err) {
    if (!(err instanceof DimensionRefusal)) throw err;
    const store = als.getStore();
    if (store) store.rollbackOnly = 'capture slip re-plan: a supplier default the dimension rules refuse (answered 400)';
    return err.message;
  }
  const byId = new Map(defaulted.map((l) => [l.id, l]));
  await writeDims(companyId, invoiceId, planned.filter((_, i) => eligible[i]).map((l) => byId.get(l.id) ?? l));
  return null;
}

/**
 * The blank lines of bill `invoiceId` inherit from the provisional `jeId` its slip was just attached to, when the bill
 * is a draft with no approval request bound (pending or approved); otherwise skipped, with the reason. Takes the
 * bill's row lock (after the caller's bank line, journal and document locks).
 */
export async function inheritOnAttach(companyId: string, invoiceId: string, jeId: string): Promise<AttachInheritance> {
  const row = await lockSupplierInvoiceForUpdate(companyId, invoiceId);
  if (!row) return { invoiceId, skipped: 'not found' };
  if (String(row.status) !== 'draft') return { invoiceId, skipped: `the bill is ${String(row.status)}, not a draft: its lines are not changed` };
  const bound = (await sql`
    SELECT 1 FROM approval_requests
     WHERE company_id = ${companyId}::UUID AND document_type = 'supplier_invoice' AND document_id = ${invoiceId}::UUID
       AND status IN ('pending', 'approved')
     LIMIT 1
  `) as DbRow[];
  if (bound.length > 0) {
    return { invoiceId, skipped: 'an approval request is bound to the bill: its lines are not changed (cancel the request to inherit)' };
  }
  const bill = await readBill(companyId, invoiceId);
  if (!bill) return { invoiceId, skipped: 'not found' };
  const items = bill.items.map((i) => (bill.head.costCenterId ? { ...i, costCenterId: bill.head.costCenterId } : i));
  const { lines, inherited } = await inheritSlipDimensions(companyId, items, bill.head,
    await attachedLines(companyId, jeId), await defaultExpenseOrNull(companyId));
  await writeDims(companyId, invoiceId, lines.filter((_, i) => inherited[i]));
  return { invoiceId, inheritedLines: inherited.filter(Boolean).length };
}
