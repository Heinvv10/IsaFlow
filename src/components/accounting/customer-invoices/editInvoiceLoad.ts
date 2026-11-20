/**
 * The edit page's stored invoice, as the detail GET returns it, and its lines as the form holds them (moved out of
 * pages/accounting/customer-invoices/edit/[invoiceId].tsx to keep it under 300 lines).
 */
import { discountFromAmount } from '@/modules/accounting/services/ar/invoiceLineAmount';
import type { EditLine } from './invoicePutBody';
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
 * the rate the form keeps behind it (the standard rate behind No VAT, as the new page does), and the effective rate the
 * lines load at (formVat keeps each loaded type while the form stays at it).
 */
export function vatAtLoad(invoice: Pick<InvoiceDetail, 'tax_rate' | 'amounts_are'>): { mode: TaxMode; formRate: number; effectiveRate: number } {
  const storedRate = Number(invoice.tax_rate ?? 15);
  const mode: TaxMode = invoice.amounts_are === 'inclusive' ? 'inclusive' : storedRate === 0 ? 'none' : 'exclusive';
  const formRate = storedRate === 0 ? 15 : storedRate;
  return { mode, formRate, effectiveRate: effectiveTaxRate(mode, formRate) };
}

/** The stored lines as the form holds them; an invoice with none starts with one empty line on the invoice's job. */
export function linesFromStoredItems(items: InvoiceItemRow[], projectId: string, vat?: { mode: TaxMode; effectiveRate: number }): EditLine[] {
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
      ...(it.vat_type && vat ? { vatType: it.vat_type, vatRateAtLoad: vat.effectiveRate } : {}),
    };
  }) : [{ key: '1', description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId }];
}
