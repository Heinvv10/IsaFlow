/**
 * The invoice PDF's line table for an invoice whose lines carry their VAT type (migration 1008). Each line prints the
 * VAT STORED on it (rounded on the line when it was priced, shared/vatLineAmounts) and a short label of its type, and
 * the column foots to the header VAT by construction (posting refuses lines that do not: invoiceVatLegs). Nothing is
 * re-allocated: vatLineAllocation exists for the legacy document-rate invoice, whose lines carry no VAT of their own.
 *
 * Null for any other invoice (a legacy one, a partly typed one, or a date no rate can be read for): the builder then
 * prints the legacy table exactly as before.
 */
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { fmtZAR } from '../core/pdfShared';
import { normaliseVatType, vatTypeLabel } from '../shared/vatTypes';
import { vatTotalLabel } from '../shared/vatLineAmounts';
import type { InvoicePdfLine } from './invoicePdfModel';

export interface TypedPdfTable {
  head: string[];
  body: string[][];
  /** The totals block's VAT label: a rate only when the VAT is that rate on the whole subtotal. */
  vatLabel: string;
}

export function typedInvoicePdfTable(
  items: readonly InvoicePdfLine[],
  invoice: { invoice_date: unknown; subtotal: unknown; tax_amount: unknown },
): TypedPdfTable | null {
  const date = invoice.invoice_date;
  if (items.length === 0 || !isRatedDate(date)) return null;
  const types = items.map((item) => (item.tax_amount == null ? null : normaliseVatType(item.vat_type)));
  if (types.some((t) => t === null)) return null;
  return {
    head: ['Description', 'Qty', 'Unit Price', 'VAT type', 'VAT', 'Amount'],
    body: items.map((item, i) => [
      String(item.description || '—'),
      Number(item.quantity || 0).toFixed(2),
      fmtZAR(Number(item.unit_price || 0)),
      vatTypeLabel(types[i]!, date),
      fmtZAR(Number(item.tax_amount)),
      fmtZAR(Number(item.amount || 0)),
    ]),
    vatLabel: vatTotalLabel(Number(invoice.subtotal || 0), standardVatRatePctOn(date), Number(invoice.tax_amount || 0)),
  };
}
