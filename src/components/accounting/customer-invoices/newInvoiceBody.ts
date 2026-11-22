/**
 * The new-invoice page's request body (pages/accounting/customer-invoices/new.tsx): what Create sends to
 * customer-invoices-create, and what the unsaved preview sends to invoice-pdf-preview (master plan wave 4, PR PV), so
 * the preview shows exactly what Create would make. Pure: the page passes one render's form, lines, mode and types.
 *
 * Per-line VAT (formVat): each line carries its `vatType` and the header no rate (the server takes the rate from the
 * type and the invoice date). A company not registered for VAT ('none') sends the legacy header rate 0 and untyped lines,
 * the shape the server stores for it whatever is sent.
 */
import { droppedLineProblem } from '@/components/accounting/customer-invoices/invoicePutBody';
import { invoiceDateProblem, type InvoiceHeaderForm, type Refused } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import type { InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { pricesToNothing, pricesToNothingMessage, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { amountsAreFor, vatRoundsToNothingProblem, vatTypeProblem, type LineVatType, type LineVatTypeOrNone } from '@/components/accounting/customer-invoices/formVat';
import type { AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

type SentLine = Omit<InvoiceLine, 'discountFromDefault' | 'accountFromDefault' | 'vatType' | 'vatFallback'>;
export type NewInvoiceBody = InvoiceHeaderForm & { taxRate?: 0; amountsAre: AmountsAre; items: (SentLine & { vatType?: LineVatType })[] };

/** The body, or the sentence saying why there is none yet (the page shows it; nothing is sent). `types`: each line's. */
export function createBody(form: InvoiceHeaderForm, lines: readonly InvoiceLine[], taxMode: TaxMode, types: readonly LineVatTypeOrNone[],
  refused: Refused): { body: NewInvoiceBody } | { problem: string } {
  if (!form.clientId) return { problem: 'Select a client' };
  const tooSmall = lines.find(l => l.description && pricesToNothing(l.unitPrice));
  if (tooSmall) return { problem: pricesToNothingMessage(tooSmall.description) };
  // Every line on screen counts in the total: one the body would drop is refused, never left out quietly.
  const dropped = droppedLineProblem(lines, false);
  if (dropped) return { problem: dropped };
  const kept = lines.map((l, i) => ({ l, type: types[i] ?? null })).filter(({ l }) => l.description && l.unitPrice > 0);
  if (kept.length === 0) return { problem: 'Add at least one line item' };
  const dateProblem = invoiceDateProblem(form, refused);
  if (dateProblem) return { problem: dateProblem };
  if (form.currencyCode !== 'ZAR' && form.exchangeRate <= 0) return { problem: 'Exchange rate must be greater than 0' };
  const strip = ({ discountFromDefault: _d, accountFromDefault: _a, vatType: _t, vatFallback: _f, ...l }: InvoiceLine): SentLine => l;
  if (taxMode === 'none') return { body: { ...form, taxRate: 0, amountsAre: 'exclusive', items: kept.map(({ l }) => strip(l)) } };
  // A line with no type yet (a scanned 14% today): the server would refuse it, so Create holds and says why.
  const untyped = vatTypeProblem(kept.map(({ l }) => l), kept.map(({ type }) => type))
    ?? vatRoundsToNothingProblem(kept.map(({ l }) => l), kept.map(({ type }) => type), taxMode, form.invoiceDate); // approve would refuse it
  if (untyped) return { problem: untyped };
  return { body: { ...form, amountsAre: amountsAreFor(taxMode), items: kept.map(({ l, type }) => ({ ...strip(l), vatType: type! })) } };
}
