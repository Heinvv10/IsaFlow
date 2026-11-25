/**
 * The invoice PDF's line table for an invoice whose lines carry their VAT type (migration 1008). Each line prints the
 * VAT STORED on it (rounded on the line when it was priced, shared/vatLineAmounts) and a short label of its type, and
 * the column foots to the header VAT by construction (posting refuses lines that do not: invoiceVatLegs). Nothing is
 * re-allocated: vatLineAllocation exists for the legacy document-rate invoice, whose lines carry no VAT of their own.
 * A line's amount is its NET on every invoice; `amounts_are` says how its unit price was entered, so the headings say
 * which column includes VAT: the unit price prints as stored, incl. VAT on an inclusive invoice.
 *
 * Null for any other invoice (a legacy one, a partly typed one, a type not in the ledger's canonical spelling
 * (invoiceVatLegs.storedVatType, the poster's reader too), or a date no rate can be read for): the builder then prints
 * the legacy table exactly as before.
 */
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { fmtZAR } from '../core/pdfShared';
import { vatTypeLabel } from '../shared/vatTypes';
import { storedVatType } from './invoiceVatLegs';
import { vatTotalLabel } from '../shared/vatLineAmounts';
import type { InvoicePdfLine } from './invoicePdfModel';

/** The typed table's autoTable columns (the invoice and quote PDFs): the legacy five with the VAT type before the VAT. */
export const TYPED_PDF_COLUMNS = {
  0: { cellWidth: 'auto' },
  1: { halign: 'right', cellWidth: 18 },
  2: { halign: 'right', cellWidth: 26 },
  3: { cellWidth: 30 },
  4: { halign: 'right', cellWidth: 24 },
  5: { halign: 'right', cellWidth: 28, fontStyle: 'bold' },
} as const;

export interface TypedPdfTable {
  head: string[];
  body: string[][];
  /** The totals block's VAT label: a rate only when the VAT is that rate on the whole subtotal. */
  vatLabel: string;
}

export function typedInvoicePdfTable(
  items: readonly InvoicePdfLine[],
  invoice: { invoice_date: unknown; subtotal: unknown; tax_amount: unknown; amounts_are?: unknown },
): TypedPdfTable | null {
  const date = invoice.invoice_date;
  if (items.length === 0 || !isRatedDate(date)) return null;
  const types = items.map((item) => (item.tax_amount == null ? null : storedVatType(item.vat_type)));
  if (types.some((t) => t === null)) return null;
  return {
    head: ['Description', 'Qty', invoice.amounts_are === 'inclusive' ? 'Unit Price (incl. VAT)' : 'Unit Price (excl. VAT)',
      'VAT type', 'VAT', 'Amount (excl. VAT)'],
    body: items.map((item, i) => [
      String(item.description || '—'),
      Number(item.quantity || 0).toFixed(2),
      fmtZAR(Number(item.unit_price || 0)),
      vatTypeLabel(types[i]!, date),
      fmtZAR(Number(item.tax_amount)),
      fmtZAR(Number(item.amount || 0)),
    ]),
    vatLabel: vatTotalLabel({
      subtotal: Number(invoice.subtotal || 0), ratePct: standardVatRatePctOn(date), vat: Number(invoice.tax_amount || 0),
    }),
  };
}
