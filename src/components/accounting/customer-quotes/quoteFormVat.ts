/**
 * The New Quote modal's per-line VAT and request body: the invoice form's model (customer-invoices/formVat), so the
 * figures the modal shows are the figures the server stores (quoteLineTax prices with the same invoiceLineVatPricing,
 * VAT rounded on each line).
 *
 *   - each line carries its OWN VAT type (standard, zero_rated, exempt), picked in the VAT column, or none of its own
 *     (`vatType` absent): the customer's default chain at render (formVat.lineVatType), so it follows the customer;
 *   - prices are sent AS ENTERED with `amountsAre` (inclusive: VAT-inclusive; the server backs each line's VAT out);
 *   - every line sent names its `vatType` and, when it has one (a stored line), its `id`, and no legacy `taxRate`, so
 *     the server never reads a type off a rate or guesses one (quoteEditLines);
 *   - a company not registered for VAT ('none') sends untyped lines and 'exclusive': the server stores no VAT for it.
 * The holds are the invoice form's: a customer, a described line, no line pricing to under a cent, every priced line a
 * type (vatTypeProblem), and no standard lines whose VAT rounds to nothing (vatRoundsToNothingProblem).
 *
 * Pure: safe in a client bundle.
 */
import { numberLines } from '@/lib/lineNumbers';
import { amountsAreFor, vatRoundsToNothingProblem, vatTypeProblem, type LineVatType, type LineVatTypeOrNone } from '@/components/accounting/customer-invoices/formVat';
import { pricesToNothing, pricesToNothingMessage, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import type { AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

export interface QuoteFormLine {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  /** The line's own type: absent = the customer's default chain; null = none yet (the line asks for one). */
  vatType?: string | null;
  /** A stored line's id: sent so its type follows it on an edit. */
  id?: string;
}

export interface QuoteFormHeader { clientId: string; customerName: string; quoteDate: string; expiryDate: string; notes: string }

export interface QuoteLinePayload { description: string; quantity: number; unitPrice: number; lineNo: number; vatType?: LineVatType; id?: string }

export type QuoteBody = QuoteFormHeader & { amountsAre: AmountsAre; lines: QuoteLinePayload[] };

/** The body Create sends, or the sentence saying why there is none yet (the modal shows it; nothing is sent). */
export function quoteBody(form: QuoteFormHeader, lines: readonly QuoteFormLine[], mode: TaxMode, types: readonly LineVatTypeOrNone[]):
  { body: QuoteBody } | { problem: string } {
  if (!form.clientId) return { problem: 'Select a customer' };
  const tooSmall = lines.find((l) => l.description && pricesToNothing(l.unitPrice));
  if (tooSmall) return { problem: pricesToNothingMessage(tooSmall.description) };
  const kept = numberLines(lines.map((l, i) => ({ l, type: types[i] ?? null })), ({ l }) => !!l.description);
  if (kept.length === 0) return { problem: 'Add at least one line item' };
  if (mode !== 'none') {
    const shown = kept.map(({ l }) => l);
    const shownTypes = kept.map(({ type }) => type);
    const problem = vatTypeProblem(shown, shownTypes) ?? vatRoundsToNothingProblem(shown, shownTypes, mode, form.quoteDate);
    if (problem) return { problem };
  }
  return {
    body: {
      ...form, amountsAre: amountsAreFor(mode),
      lines: kept.map(({ l, type, lineNo }) => ({
        description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, lineNo,
        ...(mode !== 'none' && type ? { vatType: type } : {}), ...(l.id ? { id: l.id } : {}),
      })),
    },
  };
}
