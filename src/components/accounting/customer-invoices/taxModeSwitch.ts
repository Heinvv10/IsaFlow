/**
 * What the new and edit invoice pages do when "Amounts are" changes (#1701 round 8, items 2-4). The prices shown
 * convert with the mode (taxMode.grossUnitPrice / exVatUnitPrice) so the invoice stays the same invoice, but:
 *   - each line converts at its OWN rate: the type formVat gives it (on the edit page, the type it loaded with while
 *     the form keeps its load rate), so an exempt or zero-rated line of a mixed draft is not grossed up by the header's
 *     15% (R100 standard + R100 exempt, R215, became 115 + 115 = R230, and autosave stored it);
 *   - a switch that would change what any line comes to is REFUSED, prices and mode kept: a unit price rounded to the
 *     cent before the quantity multiplies it can move the line (1,000 x R0.03 excl. is R34.50; R0.0345 rounds to R0.03,
 *     R30.00 incl.). Compared: the line's net and VAT as the shared pricing gives them (formVat.formTotals), in each mode
 *     at its own rate; to or from No VAT only the net (the VAT moves by design);
 *   - a company not registered for VAT is offered No VAT only (`taxModesFor`), and nothing converts: the server stores
 *     its lines untyped at no VAT, so a converted price would have been saved as the net.
 *
 * Pure: safe in a client bundle.
 */
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { formLineTypes, formTotals, type FormVatLine } from './formVat';
import { effectiveTaxRate, exVatUnitPrice, grossUnitPrice, TAX_MODE_OPTIONS, type TaxMode } from './taxMode';

const LABEL: Record<TaxMode, string> = { exclusive: 'Excluding VAT', inclusive: 'Including VAT', none: 'No VAT' };
const readable = (n: number): boolean => Number.isFinite(n) && Math.abs(n) < 1e15;

/** The "Amounts are" options a company is offered. */
export const taxModesFor = (registered: boolean): typeof TAX_MODE_OPTIONS =>
  (registered ? TAX_MODE_OPTIONS : TAX_MODE_OPTIONS.filter((o) => o.value === 'none'));

export interface ModeSwitch {
  from: TaxMode; to: TaxMode; formRate: number; date: string; customerVat?: string | null; registered: boolean;
  /** The invoice's currency, for the refusal's amounts (default ZAR). */
  currencyCode?: string;
}

/** The lines once the mode changes, or why the change is refused (see the header). */
export function switchTaxMode<L extends FormVatLine & { description?: string }>(lines: readonly L[], s: ModeSwitch):
  { mode: TaxMode; lines: L[] } | { problem: string } {
  if (!s.registered) return { mode: 'none', lines: [...lines] };
  // Nothing to convert between exclusive and No VAT. A form rate mid-edit (empty, NaN) or below 0 converts NOTHING: the
  // prices stay as typed and the mode changes (no 2-dp price comes back exact below 0; the rate itself holds every save,
  // formVat.NO_VAT_TYPE_PROBLEM, until it is the standard rate or 0).
  if ((s.from === 'inclusive') === (s.to === 'inclusive') || !readable(s.formRate) || s.formRate < 0) return { mode: s.to, lines: [...lines] };
  const types = formLineTypes(lines, s.formRate, s.date, s.customerVat);
  const convert = s.to === 'inclusive' ? grossUnitPrice : exVatUnitPrice;
  const converted = lines.map((l, i) => {
    // A standard line at the standard rate on the INVOICE DATE, what the server prices it at (round 11); an untyped one at
    // the form's rate (the rate check holds its save).
    const rate = types[i] === 'zero_rated' || types[i] === 'exempt' ? 0
      : types[i] === 'standard' && isRatedDate(s.date) ? standardVatRatePctOn(s.date) : s.formRate;
    return readable(l.unitPrice) ? { ...l, unitPrice: convert(l.unitPrice, rate) } : l;
  });
  const bothRated = s.from !== 'none' && s.to !== 'none';
  for (let i = 0; i < lines.length; i++) {
    const before = formTotals([lines[i]!], effectiveTaxRate(s.from, s.formRate), s.from, s.date);
    const after = formTotals([converted[i]!], effectiveTaxRate(s.to, s.formRate), s.to, s.date);
    const same = before.subtotal === after.subtotal && (!bothRated || before.tax === after.tax);
    if (!same) {
      const [was, now] = bothRated ? [before.total, after.total] : [before.subtotal, after.subtotal];
      const name = lines[i]!.description ? `"${lines[i]!.description}"` : `line ${i + 1}`;
      return { problem: `Switching to ${LABEL[s.to]} would change ${name} from ${formatCurrencyAmount(was, s.currencyCode ?? 'ZAR')} to `
        + `${formatCurrencyAmount(now, s.currencyCode ?? 'ZAR')}: its unit price cannot carry the VAT to the cent at that quantity. Change its quantity or price first, or keep ${LABEL[s.from]}.` };
    }
  }
  return { mode: s.to, lines: converted };
}
