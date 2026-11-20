/**
 * The new-invoice page's request body (pages/accounting/customer-invoices/new.tsx): what Create sends to
 * customer-invoices-create, and what the unsaved preview sends to invoice-pdf-preview (master plan wave 4, PR PV), so
 * the preview shows exactly what Create would make. Pure: the page passes one render's form, lines and mode.
 */
import { droppedLineProblem } from '@/components/accounting/customer-invoices/invoicePutBody';
import { invoiceDateProblem, type InvoiceHeaderForm, type Refused } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import type { InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { pricesToNothing, pricesToNothingMessage, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { amountsAreFor, formLineType, NO_VAT_TYPE_PROBLEM } from '@/components/accounting/customer-invoices/formVat';
import type { AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

/** The form's one rate as the legacy header taxRate (every line standard or zero_rated), prices as typed with their mode. */
export type NewInvoiceBody = Omit<InvoiceHeaderForm, 'taxRate'> & { taxRate?: number; amountsAre: AmountsAre; items: (Omit<InvoiceLine, 'discountFromDefault' | 'accountFromDefault'> & { vatType?: 'exempt' })[] };

/** The body, or the sentence saying why there is none yet (the page shows it; nothing is sent). */
export function createBody(form: InvoiceHeaderForm, lines: readonly InvoiceLine[], taxMode: TaxMode, taxRate: number,
  refused: Refused, customerVat?: string | null): { body: NewInvoiceBody } | { problem: string } {
  if (!form.clientId) return { problem: 'Select a client' };
  const tooSmall = lines.find(l => l.description && pricesToNothing(l.unitPrice));
  if (tooSmall) return { problem: pricesToNothingMessage(tooSmall.description) };
  // Every line on screen counts in the total: one the body would drop is refused, never left out quietly.
  const dropped = droppedLineProblem(lines, false);
  if (dropped) return { problem: dropped };
  const validLines = lines.map(({ discountFromDefault: _fromDefault, accountFromDefault: _accountFromDefault, ...l }) => l).filter(l => l.description && l.unitPrice > 0);
  if (validLines.length === 0) return { problem: 'Add at least one line item' };
  const dateProblem = invoiceDateProblem(form, refused);
  if (dateProblem) return { problem: dateProblem };
  if (form.currencyCode !== 'ZAR' && form.exchangeRate <= 0) return { problem: 'Exchange rate must be greater than 0' };
  // A rate that gives no VAT type (a scanned 14% today, a rate mid-edit): the server refuses it, so Create holds and says why.
  if (formLineType(taxRate, form.invoiceDate, customerVat) === null) return { problem: NO_VAT_TYPE_PROBLEM };
  // An exempt customer at no VAT: every line exempt, as the server types its lines by default (no header rate, which maps
  // 0 to zero_rated). Otherwise the form's one rate, the legacy header contract.
  if (formLineType(taxRate, form.invoiceDate, customerVat) === 'exempt') {
    const { taxRate: _rate, ...header } = { ...form, taxRate };
    return { body: { ...header, amountsAre: amountsAreFor(taxMode), items: validLines.map((l) => ({ ...l, vatType: 'exempt' as const })) } };
  }
  return { body: { ...form, taxRate, amountsAre: amountsAreFor(taxMode), items: validLines } };
}
