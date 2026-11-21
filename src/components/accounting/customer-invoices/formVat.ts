/**
 * The new and edit invoice pages' VAT, until the line-level VAT screen. The form keeps one rate and one "Amounts are"
 * mode; each line's VAT type is:
 *   - on the edit page, the type the line LOADED with, while the form's rate is still the one it loaded at (a mixed
 *     invoice made through the API round-trips: its exempt line is not re-typed by the header's 15%);
 *   - otherwise the one the form's rate gives, as the server's legacy header contract does (invoiceLineVatTypes): the
 *     standard rate on the invoice date -> standard, 0 -> zero_rated, or exempt when the customer's default VAT type is
 *     exempt (as the server's default chain types such a customer's lines; review round 1 of #1701).
 * Prices are sent AS ENTERED with the mode (inclusive: VAT-inclusive), and the totals are the shared per-line pricing
 * (invoiceLineVatPricing), so the summary shows the figure create and the draft edit store. A rate that gives no type
 * (neither the standard rate nor 0: the server refuses it, saying why) is shown as VAT on the subtotal at that rate. A
 * company not registered for VAT prices at no VAT ('none'), as the server forces it.
 *
 * Pure: safe in a client bundle (useVatMode reads the active company's registration).
 */
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { previewLineAmount, previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { previewInvoiceVat, type AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';
import type { DocumentLineVatType } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import { DOCUMENT_LINE_VAT_TYPES } from '@/modules/accounting/services/shared/vatTypes';
import { sameCents } from '@/modules/accounting/services/shared/functionalAmounts';
import { exVatUnitPrice, linesForModeChange, TAX_MODE_OPTIONS, type TaxMode } from './taxMode';

export interface FormVatLine {
  quantity: number; unitPrice: number; discount?: number;
  /** The edit page: the type the line loaded with, and the form's effective rate then. */
  vatType?: string | null; vatRateAtLoad?: number;
}

/** The mode the form prices and sends in: 'none' for a company not registered for VAT, whatever is picked. */
export const vatModeFor = (registered: boolean, picked: TaxMode): TaxMode => (registered ? picked : 'none');

/** What the server stores the prices as, for the form's mode. */
export const amountsAreFor = (mode: TaxMode): AmountsAre => (mode === 'inclusive' ? 'inclusive' : 'exclusive');

const isExemptCustomer = (customerVat: string | null | undefined): boolean => (customerVat ?? '').trim().toLowerCase() === 'exempt';

/** The one type the form's rate gives a line on `date`, or null for a rate that is neither the standard rate nor 0. */
export function formLineType(rate: number, date: string, customerVat?: string | null): DocumentLineVatType | null {
  if (rate === 0) return isExemptCustomer(customerVat) ? 'exempt' : 'zero_rated';
  return isRatedDate(date) && rate === standardVatRatePctOn(date) ? 'standard' : null;
}

/** The refusal a save of the form shows when its rate gives a line no type (the server would refuse it, as autosave holds). */
export const NO_VAT_TYPE_PROBLEM = 'Check the VAT rate: it is the standard rate on the invoice date, or 0';

/** Each line's type (see the header), or null where the form's rate gives none. */
export function formLineTypes(lines: readonly FormVatLine[], rate: number, date: string, customerVat?: string | null): (DocumentLineVatType | null)[] {
  const fromRate = formLineType(rate, date, customerVat);
  return lines.map((l) => {
    const loaded = (DOCUMENT_LINE_VAT_TYPES as readonly string[]).includes(l.vatType ?? '') ? l.vatType as DocumentLineVatType : null;
    return loaded && l.vatRateAtLoad === rate ? loaded : fromRate;
  });
}

function typedTotals(lines: readonly FormVatLine[], rate: number, mode: TaxMode, date: string): { subtotal: number; tax: number; total: number } {
  const types = formLineTypes(lines, rate, date);
  if (types.some((t) => t === null)) {
    const ex = (p: number) => (mode === 'inclusive' ? exVatUnitPrice(p, rate) : p);
    return previewTotals(lines.map((l) => previewLineAmount(l.quantity, ex(l.unitPrice), l.discount || 0)), rate);
  }
  return previewInvoiceVat(lines, types as DocumentLineVatType[], date, amountsAreFor(mode));
}

/** The summary's totals, `unitPrice` as entered in `mode` (see the header). */
export const formTotals = (lines: readonly FormVatLine[], rate: number, mode: TaxMode, date: string): { subtotal: number; tax: number; total: number } =>
  typedTotals(lines, rate, mode, date);

/** One line's amount as stored: its net (an inclusive line's VAT backed out of its gross). */
export const formLineNet = (line: FormVatLine, rate: number, mode: TaxMode, date: string): number => typedTotals([line], rate, mode, date).subtotal;

const samePricing = (a: { subtotal: number; tax: number }, b: { subtotal: number; tax: number }): boolean =>
  sameCents(a.subtotal, b.subtotal) && sameCents(a.tax, b.tax);

/**
 * The page's "Amounts are" change. `from` and `to` are the modes the form prices in (vatModeFor: a company not registered
 * for VAT is at 'none' in both, so nothing converts). Each line's price converts (taxMode.linesForModeChange) at its OWN
 * rate: 0 for a zero-rated or exempt line, the form's otherwise, typed at the form's rate (the rate the inclusive side
 * prices at), so a mixed invoice's exempt line keeps its price. Refused, naming the line, when a converted price would
 * change what the line is stored as: the price is rounded to the cent before its quantity multiplies it (1 000 x R0.03
 * excl is R0.0345 incl, shown as R0.03: R34.50 would become R30.00).
 */
export function formLinesForModeChange<L extends FormVatLine & { description: string }>(
  lines: readonly L[], from: TaxMode, to: TaxMode, formRate: number, date: string,
): { lines: L[] } | { problem: string } {
  const types = formLineTypes(lines, formRate, date);
  const shown = lines.map((l, i) => linesForModeChange([l], from, to, types[i] === 'zero_rated' || types[i] === 'exempt' ? 0 : formRate)[0]!);
  const repriced = shown.findIndex((s, i) => s !== lines[i] && !samePricing(typedTotals([lines[i]!], formRate, from, date), typedTotals([s], formRate, to, date)));
  if (repriced < 0) return { lines: shown };
  const name = lines[repriced]!.description ? `"${lines[repriced]!.description}"` : `Line ${repriced + 1}`;
  const label = (m: TaxMode) => TAX_MODE_OPTIONS.find((o) => o.value === m)!.label;
  return { problem: `${name} would come to a different total in ${label(to)} (its price rounds to the cent): amounts stay ${label(from)} - change its price or quantity first` };
}
