/**
 * The refusals `lockAndPlanSupplierInvoiceDraftUpdate` raises that need their
 * own reads: the replacement lines, a settlement naming the bill, and a
 * number another live bill of the supplier already carries. All run before
 * any write. Split from supplierInvoiceDraftUpdate.ts for the 300-line cap.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { journalStandsFragment } from '../shared/journalInForceAsAt';
import type { SupplierInvoiceItemInput } from '../../types/ap.types';
import { billLineAccountRefusal } from './billLineAccountGuard';
import { deriveLineDimensions } from '../gl/dimensions/dimensionDerivation';
import { isDimensionRefusal } from '../gl/dimensions/dimensionTypes';
import { assertDocumentDimensions } from '../gl/dimensions/dimensionPolicy';
import { keepStoredDimensions } from '../gl/dimensions/dimensionKeepStored';
import {
  assertSupplierInvoiceLines,
  computeSupplierInvoiceTotals,
  defaultVatClassification,
  type ComputedSupplierInvoiceItem,
  type SupplierInvoiceTotals,
} from './supplierInvoiceTotals';

/** A refusal whose message is safe to show the caller. Raised before any write. */
export class SupplierInvoiceDraftUpdateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoiceDraftUpdateRefusal';
  }
}

/**
 * Validate the replacement lines and refuse when the stored lines carry what
 * the replacement cannot express — a purchase-order line link, a project or
 * cost centre, or a VAT classification other than the rate's default (an
 * exempt 0% line would silently become zero-rated). Dropping those is data loss.
 * CC1 / CC2 / BU a line leaves out keep the value every stored line shares, and
 * are refused when the stored lines differ (dimensionKeepStored).
 */
export async function planLines(
  companyId: string,
  invoiceId: string,
  number: string,
  items: SupplierInvoiceItemInput[],
  taxRate: number,
): Promise<(SupplierInvoiceTotals & { taxRate: number }) | null> {
  try {
    assertSupplierInvoiceLines(items, false);
  } catch (err) {
    throw new SupplierInvoiceDraftUpdateRefusal((err as Error).message);
  }
  const accountRefusal = await billLineAccountRefusal(companyId, items.map((i) => i.glAccountId));
  if (accountRefusal) throw new SupplierInvoiceDraftUpdateRefusal(accountRefusal);
  const kept = (await sql`
    SELECT description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id,
           po_item_id, project_id, cost_center_id, vat_classification, cc1_id, cc2_id, bu_id
    FROM supplier_invoice_items
    WHERE supplier_invoice_id = ${invoiceId}::UUID`) as DbRow[];
  let totals: SupplierInvoiceTotals;
  try {
    const computed = computeSupplierInvoiceTotals(keepStoredDimensions(items, kept), taxRate, false);
    // CC1 derived from each line's CC2; a conflicting CC1 is refused (no query without a CC2).
    totals = { ...computed, items: await deriveLineDimensions(companyId, computed.items) };
    await assertDocumentDimensions(companyId, totals.items);
  } catch (err) {
    if (isDimensionRefusal(err)) throw new SupplierInvoiceDraftUpdateRefusal(err.message);
    throw err;
  }
  // Lines resent exactly as stored: nothing to replace, and nothing to drop.
  // Structural, not a joined string: description is free text and may carry
  // any separator, so a joined form lets one sent line equal two stored ones.
  const key = (l: Pick<ComputedSupplierInvoiceItem,
    'description' | 'quantity' | 'unitPrice' | 'taxRate' | 'taxAmount' | 'lineTotal' | 'glAccountId'
    | 'cc1Id' | 'cc2Id' | 'buId'>) =>
    JSON.stringify([l.description, l.quantity.toFixed(4), l.unitPrice.toFixed(2), l.taxRate.toFixed(2),
      l.taxAmount.toFixed(2), l.lineTotal.toFixed(2), l.glAccountId ?? null,
      l.cc1Id?.toLowerCase() ?? null, l.cc2Id?.toLowerCase() ?? null, l.buId?.toLowerCase() ?? null]);
  const stored = kept.map((l) => key({
    description: String(l.description), quantity: Number(l.quantity), unitPrice: Number(l.unit_price),
    taxRate: Number(l.tax_rate), taxAmount: Number(l.tax_amount), lineTotal: Number(l.line_total),
    glAccountId: l.gl_account_id ? String(l.gl_account_id) : undefined,
    cc1Id: l.cc1_id ? String(l.cc1_id) : undefined,
    cc2Id: l.cc2_id ? String(l.cc2_id) : undefined,
    buId: l.bu_id ? String(l.bu_id) : undefined,
  })).sort();
  const sent = totals.items.map(key).sort();
  if (stored.length === sent.length && stored.every((k, i) => k === sent[i])) return null;
  const lost = kept.find((l) => l.po_item_id || l.project_id || l.cost_center_id
    || (l.vat_classification
        && l.vat_classification !== defaultVatClassification(Number(l.tax_rate ?? 0))));
  if (lost) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number}'s line "${String(lost.description)}" carries a purchase-order link, `
      + 'project, cost centre or VAT classification that replacing the lines would drop. '
      + 'Edit it in the app instead, or cancel and re-enter it.',
    );
  }
  return { ...totals, taxRate };
}

/** Migration 646's index — (company, supplier, number) on live, non-blank rows — as a worded refusal. */
export async function refuseIfNumberTaken(
  companyId: string, invoiceId: string, supplierId: string, invoiceNumber: string,
): Promise<void> {
  const taken = (await sql`
    SELECT status FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${supplierId}::UUID
      AND invoice_number = ${invoiceNumber} AND invoice_number <> '' AND deleted_at IS NULL
      AND id <> ${invoiceId}::UUID
    LIMIT 1`) as DbRow[];
  if (taken[0]) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `This supplier already has a ${String(taken[0].status)} bill numbered ${invoiceNumber}.`,
    );
  }
}

/**
 * A live payment allocation or credit note already names this bill and its
 * amount. Changing the total or the supplier under it would leave that
 * settlement pointing at a different debt.
 */
export async function refuseIfSettlementPlanned(companyId: string, invoiceId: string, number: string): Promise<void> {
  const refs = (await sql`
    SELECT 'payment' AS kind, sp.payment_number AS ref, sp.status
    FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE pa.invoice_id = ${invoiceId}::UUID AND sp.company_id = ${companyId}::UUID
      AND sp.status <> 'cancelled'
    UNION ALL
    SELECT 'credit note', cn.credit_note_number, cn.status
    FROM credit_notes cn
    WHERE cn.supplier_invoice_id = ${invoiceId}::UUID AND cn.company_id = ${companyId}::UUID
      AND cn.status <> 'cancelled'
    LIMIT 1`) as DbRow[];
  if (refs[0]) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number} is named on ${String(refs[0].status)} ${String(refs[0].kind)} `
      + `${String(refs[0].ref)}, so its total and supplier cannot change. Remove it from that `
      + `${String(refs[0].kind)} first.`,
    );
  }
}

/**
 * A posted journal sourced from this bill that its reversal chain leaves
 * standing (D8: one reversed and re-reversed still carries the bill's figures). `applyDRCVat` posted one
 * on DRAFTS until 2026-09-23 (legacy rows remain) and leaves `gl_journal_entry_id`
 * NULL, so the link column alone misses it; editing the base under it would leave the DRC
 * VAT on the old figure, and nothing re-runs it (`is_drc` bills are excluded).
 */
export async function refuseIfJournalNamesBill(
  companyId: string, invoiceId: string, number: string, isDrc: boolean,
): Promise<void> {
  const rows = (await sql`
    SELECT je.entry_number FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID AND je.source_record_id = ${invoiceId}::UUID
      AND je.status = 'posted' AND ${journalStandsFragment('je.id', companyId)}
    ORDER BY je.entry_number LIMIT 1`) as DbRow[];
  if (rows[0] || isDrc) {
    const what = rows[0]
      ? `posted journal ${String(rows[0].entry_number)} is sourced from it`
      : 'is marked as DRC VAT applied';
    // Reversing a DRC journal leaves is_drc set, so for a DRC bill the only way
    // back is a new bill: cancel_supplier_invoice refuses while the journal stands.
    const cancel = 'cancel the bill with cancel_supplier_invoice and re-enter it.';
    const remedy = !isDrc
      ? `Reverse that journal with reverse_journal_entry, or ${cancel}`
      : rows[0]
        ? `Reverse that journal with reverse_journal_entry, then ${cancel}`
        : `Its DRC journal is already reversed; ${cancel}`;
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number} is a draft but ${what}, so editing it would leave that VAT on the `
      + `old figures. ${remedy}`,
    );
  }
}

/**
 * Records that captured this bill's identity or amount and would describe a
 * different bill after the edit: an approval request (its `amount` is a
 * snapshot — approving R1,000 then raising the draft leaves the approval
 * vouching for a figure it never saw), a supplier-statement line matched to it,
 * and — on a supplier change only — the coding history that taught the old
 * supplier's rules from it.
 */
export async function refuseIfRecordsPinBill(
  companyId: string, invoiceId: string, number: string, supplierChanges: boolean,
): Promise<void> {
  const rows = (await sql`
    SELECT 'an approval request' AS kind, ar.status AS detail
    FROM approval_requests ar
    WHERE ar.company_id = ${companyId}::UUID AND ar.document_type = 'supplier_invoice'
      AND ar.document_id = ${invoiceId}::UUID AND ar.status IN ('pending', 'approved')
    UNION ALL
    SELECT 'a supplier-statement line', ssl.reference
    FROM supplier_statement_lines ssl
    JOIN supplier_statement_reconciliations ssr ON ssr.id = ssl.reconciliation_id
    WHERE ssr.company_id = ${companyId}::UUID AND ssl.matched_supplier_invoice_id = ${invoiceId}::UUID
    UNION ALL
    SELECT 'supplier coding history', NULL
    FROM supplier_coding_history h
    WHERE ${supplierChanges} AND h.company_id = ${companyId}::UUID
      AND h.supplier_invoice_id = ${invoiceId}::UUID
    LIMIT 1`) as DbRow[];
  if (rows[0]) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number} is recorded on ${String(rows[0].kind)}`
      + `${rows[0].detail ? ` (${String(rows[0].detail)})` : ''}, so its supplier, number and total `
      + 'cannot change. Cancel the bill and re-enter it.',
    );
  }
}
