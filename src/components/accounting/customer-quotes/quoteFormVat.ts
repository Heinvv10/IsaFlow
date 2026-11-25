/**
 * The New Quote modal's per-line VAT and request body: the invoice form's model (customer-invoices/formVat), so the
 * figures the modal shows are the figures the server stores (quoteLineTax prices with the same invoiceLineVatPricing,
 * VAT rounded on each line).
 *
 *   - each line carries its OWN VAT type (standard, zero_rated, exempt), picked in the VAT column, or none of its own
 *     (`vatType` absent): the customer's default chain at render (formVat.lineVatType), so it follows the customer;
 *   - an "Including VAT" quote is sent EX-VAT, as this modal always did (storedForm): each rated line's typed price is
 *     converted at its own rate (exVatUnitPrice) and sent with `amountsAre` exclusive, so a quote's stored total is what
 *     it was before per-line VAT, and the modal shows that same total (it does not move on save);
 *   - every line sent names its `vatType` and no legacy `taxRate`, so the server never reads a type off a rate (the
 *     modal only creates: quotes have no edit screen, so no line carries a stored id);
 *   - a company not registered for VAT ('none') sends untyped lines and 'exclusive': the server stores no VAT for it.
 * The holds are the invoice form's: a customer, a quote date (with a VAT rate, for a VAT vendor: the server prices on
 * that date, and on today's when none is sent), a described line and no priced line without a description (it would be
 * dropped), no line pricing to under a cent, every priced line a type (vatTypeProblem), and no standard lines whose
 * VAT rounds to nothing (vatRoundsToNothingProblem).
 *
 * Pure: safe in a client bundle.
 */
import { numberLines } from '@/lib/lineNumbers';
import { isRatedDate } from '@/lib/vat/standardRate';
import { lineVatRate, vatRoundsToNothingProblem, vatTypeProblem, type FormVatLine, type LineVatType, type LineVatTypeOrNone } from '@/components/accounting/customer-invoices/formVat';
import { exVatUnitPrice, pricesToNothing, pricesToNothingMessage, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import type { AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

export interface QuoteFormLine {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  /** The line's own type: absent = the customer's default chain; null = none yet (the line asks for one). */
  vatType?: string | null;
}

export interface QuoteFormHeader { clientId: string; customerName: string; quoteDate: string; expiryDate: string; notes: string }

export interface QuoteLinePayload { description: string; quantity: number; unitPrice: number; lineNo: number; vatType?: LineVatType }

export type QuoteBody = QuoteFormHeader & { amountsAre: AmountsAre; lines: QuoteLinePayload[] };

/**
 * The lines and mode a quote is stored in (and so shown in): an inclusive quote's rated lines at their ex-VAT price,
 * priced exclusive. Any other mode is as typed.
 */
export function storedForm<L extends FormVatLine>(lines: readonly L[], types: readonly LineVatTypeOrNone[], mode: TaxMode, date: string): { lines: L[]; mode: TaxMode } {
  if (mode !== 'inclusive') return { lines: [...lines], mode };
  return {
    mode: 'exclusive',
    lines: lines.map((l, i) => {
      const rate = lineVatRate(types[i] ?? null, date);
      return rate > 0 ? { ...l, unitPrice: exVatUnitPrice(l.unitPrice, rate) } : l;
    }),
  };
}

/** A line with a description (spaces alone are none): only such a line is sent, and every hold reads it the same way. */
const described = (l: QuoteFormLine): boolean => l.description.trim() !== '';

/** The body Create sends, or the sentence saying why there is none yet (the modal shows it; nothing is sent). */
export function quoteBody(form: QuoteFormHeader, lines: readonly QuoteFormLine[], mode: TaxMode, types: readonly LineVatTypeOrNone[]):
  { body: QuoteBody } | { problem: string } {
  if (!form.clientId) return { problem: 'Select a customer' };
  if (!form.quoteDate) return { problem: 'Enter the quote date' };
  if (mode !== 'none' && !isRatedDate(form.quoteDate)) return { problem: 'The quote date is before VAT began: enter a later date' };
  const undescribed = lines.findIndex((l) => !described(l) && l.unitPrice !== 0);
  if (undescribed >= 0) return { problem: `Line ${undescribed + 1} needs a description` };
  const tooSmall = lines.find((l) => described(l) && pricesToNothing(l.unitPrice));
  if (tooSmall) return { problem: pricesToNothingMessage(tooSmall.description) };
  const kept = numberLines(lines.map((l, i) => ({ l, type: types[i] ?? null })), ({ l }) => described(l));
  if (kept.length === 0) return { problem: 'Add at least one line item' };
  const shownTypes = kept.map(({ type }) => type);
  const stored = storedForm(kept.map(({ l }) => l), shownTypes, mode, form.quoteDate);
  if (mode !== 'none') {
    const problem = vatTypeProblem(stored.lines, shownTypes) ?? vatRoundsToNothingProblem(stored.lines, shownTypes, stored.mode, form.quoteDate);
    if (problem) return { problem };
  }
  return {
    body: {
      ...form, amountsAre: 'exclusive',
      lines: kept.map(({ l, type, lineNo }, i) => ({
        description: l.description, quantity: l.quantity, unitPrice: stored.lines[i]!.unitPrice, lineNo,
        ...(mode !== 'none' && type ? { vatType: type } : {}),
      })),
    },
  };
}
