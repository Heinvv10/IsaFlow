/**
 * The new-invoice page's request body (pages/accounting/customer-invoices/new.tsx): what Create sends to
 * customer-invoices-create, and what the unsaved preview sends to invoice-pdf-preview (master plan wave 4, PR PV), so
 * the preview shows exactly what Create would make. Pure: the page passes one render's form, lines and mode.
 */
import { droppedLineProblem } from '@/components/accounting/customer-invoices/invoicePutBody';
import { invoiceDateProblem, type InvoiceHeaderForm, type Refused } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import type { InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { pricesToNothing, pricesToNothingMessage, storedUnitPrice, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';

export type NewInvoiceBody = InvoiceHeaderForm & { taxRate: number; items: Omit<InvoiceLine, 'discountFromDefault'>[] };

/** The body, or the sentence saying why there is none yet (the page shows it; nothing is sent). */
export function createBody(form: InvoiceHeaderForm, lines: readonly InvoiceLine[], taxMode: TaxMode, taxRate: number,
  refused: Refused): { body: NewInvoiceBody } | { problem: string } {
  if (!form.clientId) return { problem: 'Select a client' };
  const tooSmall = lines.find(l => l.description && pricesToNothing(taxMode, l.unitPrice, taxRate));
  if (tooSmall) return { problem: pricesToNothingMessage(tooSmall.description) };
  // Every line on screen counts in the total: one the body would drop is refused, never left out quietly.
  const dropped = droppedLineProblem(lines, false);
  if (dropped) return { problem: dropped };
  const validLines = lines.map(({ discountFromDefault: _fromDefault, ...l }) => ({ ...l, unitPrice: storedUnitPrice(taxMode, l.unitPrice, taxRate) })).filter(l => l.description && l.unitPrice > 0);
  if (validLines.length === 0) return { problem: 'Add at least one line item' };
  const dateProblem = invoiceDateProblem(form, refused);
  if (dateProblem) return { problem: dateProblem };
  if (form.currencyCode !== 'ZAR' && form.exchangeRate <= 0) return { problem: 'Exchange rate must be greater than 0' };
  return { body: { ...form, taxRate, items: validLines } };
}
