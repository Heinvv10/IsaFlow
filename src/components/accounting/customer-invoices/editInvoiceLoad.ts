/**
 * The edit page's stored invoice, as the detail GET returns it, and its lines as the form holds them (moved out of
 * pages/accounting/customer-invoices/edit/[invoiceId].tsx to keep it under 300 lines).
 */
import { discountFromAmount } from '@/modules/accounting/services/ar/invoiceLineAmount';
import type { EditLine } from './invoicePutBody';

const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };

export type InvoiceItemRow = {
  description?: string; unit_price?: number | string; quantity?: number | string;
  amount?: number | string; tax_rate?: number | string;
  gl_account_id?: string | null; project_id?: string | null; cc1_id?: string | null; cc2_id?: string | null; bu_id?: string | null;
  time_entry_id?: string | null;
};
export type InvoiceDetail = {
  id: string; status: string; invoice_number: string;
  client_id?: string | null; customer_id?: string | null;
  invoice_date: string; due_date?: string | null;
  billing_period_start?: string | null; billing_period_end?: string | null;
  tax_rate: number | string; notes?: string | null; total_amount?: number | string;
  currency_code?: string | null; exchange_rate?: number | string | null; project_id?: string | null;
  items?: InvoiceItemRow[];
};

/** The stored lines as the form holds them; an invoice with none starts with one empty line on the invoice's job. */
export function linesFromStoredItems(items: InvoiceItemRow[], projectId: string): EditLine[] {
  // The schema has no `discount` column — it is folded into `amount`.
  // Reverse-engineer percent discount from amount vs (qty × unitPrice) so a
  // saved-then-reopened invoice round-trips without silently zeroing it —
  // exactly, so an unchanged save re-prices to the stored amount.
  return items.length > 0 ? items.map((it, i) => {
    const qty = Number(it.quantity || 1);
    const unitPrice = Number(it.unit_price || 0);
    const amount = Number(it.amount ?? qty * unitPrice);
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
    };
  }) : [{ key: '1', description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId }];
}
