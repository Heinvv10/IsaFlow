/**
 * The edit page's stored invoice, as the detail GET returns it, and its lines as the form holds them (moved out of
 * pages/accounting/customer-invoices/edit/[invoiceId].tsx to keep it under 300 lines).
 */
import { discountFromAmount } from '@/modules/accounting/services/ar/invoiceLineAmount';
import type { EditLine } from './invoicePutBody';
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { effectiveTaxRate, type TaxMode } from './taxMode';

const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };

export type InvoiceItemRow = {
  description?: string; unit_price?: number | string; quantity?: number | string;
  amount?: number | string; tax_rate?: number | string;
  /** Per-line VAT (migration 1008): the line's type and VAT, null on a legacy line. */
  vat_type?: string | null; tax_amount?: number | string | null;
  gl_account_id?: string | null; project_id?: string | null; cc1_id?: string | null; cc2_id?: string | null; bu_id?: string | null;
  time_entry_id?: string | null;
};
export type InvoiceDetail = {
  id: string; status: string; invoice_number: string;
  client_id?: string | null; customer_id?: string | null;
  invoice_date: string; due_date?: string | null;
  /** Where the due date came from (migration 962): only a `terms` one follows a changed date or customer on the edit page. */
  due_date_source?: string | null;
  billing_period_start?: string | null; billing_period_end?: string | null;
  tax_rate: number | string; notes?: string | null; total_amount?: number | string;
  /** How unit_price reads: 'inclusive' = VAT-inclusive as entered (its line amount is the net). NULL = exclusive. */
  amounts_are?: string | null;
  currency_code?: string | null; exchange_rate?: number | string | null; project_id?: string | null;
  shown_digest?: string; // invoicePdfModel: Approve sends it back
  draft_digest?: string; // invoicePdfModel: each draft PUT sends it back
  /** Billed time entries no line links (a grouped WIP or timesheet invoice): removing a line leaves them billed. */
  unlinked_time_entries?: number | string;
  items?: InvoiceItemRow[];
};

/**
 * The form's VAT as the invoice stored it: its mode (inclusive when amounts_are says so; No VAT at a stored rate of 0),
 * the rate the form keeps behind it (the standard rate behind No VAT, as the new page does; an inclusive draft at 0%
 * keeps 0), and the effective rate the
 * lines load at (formVat keeps each loaded type while the form stays at it).
 */
export function vatAtLoad(invoice: Pick<InvoiceDetail, 'tax_rate' | 'amounts_are'> & { invoice_date?: string }):
  { mode: TaxMode; formRate: number; effectiveRate: number; date?: string } {
  const storedRate = Number(invoice.tax_rate ?? 15);
  const mode: TaxMode = invoice.amounts_are === 'inclusive' ? 'inclusive' : storedRate === 0 ? 'none' : 'exclusive';
  // No VAT keeps the standard rate behind it; an INCLUSIVE draft stored at 0% keeps its 0 (#1701 round 8: it reloaded at 15%,
  // so a line added to it went standard and carried VAT).
  const formRate = storedRate === 0 && mode !== 'inclusive' ? 15 : storedRate;
  return { mode, formRate, effectiveRate: effectiveTaxRate(mode, formRate), ...(invoice.invoice_date ? { date: String(invoice.invoice_date).slice(0, 10) } : {}) };
}

/** The stored lines as the form holds them; an invoice with none starts with one empty line on the invoice's job. */
/**
 * A LEGACY line's effective type (round 11): from its OWN stored rate, else whether it carries VAT, else the header's;
 * 0 -> zero_rated, the standard rate on the invoice date -> standard, any other rate (a 14% legacy line) none, so the
 * form's rate check holds the save rather than repricing it. So a mixed legacy draft (R100 at 15% + R100 at 0%) keeps
 * R215; read at the header rate it became R230.
 */
function legacyLineType(it: InvoiceItemRow, vat: { effectiveRate: number; date?: string }): string | null {
  const rate = it.tax_rate != null && it.tax_rate !== '' ? Number(it.tax_rate)
    : it.tax_amount != null ? (Number(it.tax_amount) > 0 ? null : 0) : vat.effectiveRate;
  if (rate === 0) return 'zero_rated';
  if (rate === null) return 'standard'; // VAT on it, no rate stored: the standard rate is the only one a sale carries
  return vat.date && isRatedDate(vat.date) && rate === standardVatRatePctOn(vat.date) ? 'standard' : null;
}

export function linesFromStoredItems(items: InvoiceItemRow[], projectId: string, vat?: { mode: TaxMode; effectiveRate: number; date?: string }): EditLine[] {
  // The schema has no `discount` column — it is folded into `amount`.
  // Reverse-engineer percent discount from amount vs (qty × unitPrice) so a
  // saved-then-reopened invoice round-trips without silently zeroing it —
  // exactly, so an unchanged save re-prices to the stored amount. On an
  // inclusive invoice the unit price is VAT-inclusive and `amount` the net:
  // the discount is read against the line's GROSS (amount + its VAT).
  return items.length > 0 ? items.map((it, i) => {
    const qty = Number(it.quantity || 1);
    const unitPrice = Number(it.unit_price || 0);
    const net = Number(it.amount ?? qty * unitPrice);
    const amount = vat?.mode === 'inclusive' ? Math.round((net + Number(it.tax_amount ?? 0)) * 100) / 100 : net;
    const discount = discountFromAmount(qty, unitPrice, amount);
    return {
      key: String(i),
      description: String(it.description || ''),
      quantity: qty,
      unitPrice,
      discount,
      glAccountId: it.gl_account_id ?? '',
      projectId: it.project_id ?? '',
      cc2Id: it.cc2_id ?? '',
      buId: it.bu_id ?? '',
      cc1Id: it.cc1_id ?? null,
      cc2AtLoad: it.cc2_id ?? '',
      timeEntryId: it.time_entry_id ?? null,
      ...(vat && (it.vat_type ?? legacyLineType(it, vat)) ? { vatType: (it.vat_type ?? legacyLineType(it, vat))!, vatRateAtLoad: vat.effectiveRate } : {}),
    };
  }) : [{ key: '1', description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId }];
}
