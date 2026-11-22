/**
 * What the new and edit invoice pages do when "Amounts are" changes (#1701 round 8, items 2-4). The prices shown
 * convert with the mode (taxMode.grossUnitPrice / exVatUnitPrice) so the invoice stays the same invoice, but:
 *   - each line converts at its OWN type's rate on the invoice date (formVat.lineVatType), so an exempt or zero-rated
 *     line of a mixed draft is not grossed up (R100 standard + R100 exempt, R215, became 115 + 115 = R230, and autosave
 *     stored it);
 *   - a switch that would change what any line comes to is REFUSED, prices and mode kept: a unit price rounded to the
 *     cent before the quantity multiplies it can move the line (1,000 x R0.03 excl. is R34.50; R0.0345 rounds to R0.03,
 *     R30.00 incl.). Compared: the line's net and VAT as the shared pricing gives them (formVat.formTotals), in each mode;
 *   - an invoice date with no VAT rate yet (empty, mid-edit) refuses a switch that would convert: nothing to convert at;
 *   - a company not registered for VAT is offered No VAT only (`taxModesFor`), and nothing converts: the server stores
 *     its lines untyped at no VAT, so a converted price would have been saved as the net.
 *
 * Pure: safe in a client bundle.
 */
import { isRatedDate } from '@/lib/vat/standardRate';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { formTotals, lineVatRate, type FormVatLine, type LineVatTypeOrNone } from './formVat';
import { exVatUnitPrice, grossUnitPrice, TAX_MODE_OPTIONS, type TaxMode } from './taxMode';

const LABEL: Record<TaxMode, string> = { exclusive: 'Excluding VAT', inclusive: 'Including VAT', none: 'No VAT' };
const readable = (n: number): boolean => Number.isFinite(n) && Math.abs(n) < 1e15;

/** The "Amounts are" options a company is offered: VAT-free lines are typed per line, so No VAT only for a non-vendor. */
export const taxModesFor = (registered: boolean): typeof TAX_MODE_OPTIONS =>
  TAX_MODE_OPTIONS.filter((o) => (registered ? o.value !== 'none' : o.value === 'none'));

export interface ModeSwitch {
  from: TaxMode; to: TaxMode; date: string; registered: boolean;
  /** Each line's VAT type (formVat.lineVatTypes), in line order. */
  types: readonly LineVatTypeOrNone[];
  /** The invoice's currency, for the refusal's amounts (default ZAR). */
  currencyCode?: string;
}

/** The lines once the mode changes, or why the change is refused (see the header). */
export function switchTaxMode<L extends FormVatLine & { description?: string }>(lines: readonly L[], s: ModeSwitch):
  { mode: TaxMode; lines: L[] } | { problem: string } {
  if (!s.registered) return { mode: 'none', lines: [...lines] };
  if ((s.from === 'inclusive') === (s.to === 'inclusive')) return { mode: s.to, lines: [...lines] };
  if (!isRatedDate(s.date) && lines.some((l, i) => readable(l.unitPrice) && l.unitPrice !== 0 && s.types[i] === 'standard')) {
    return { problem: `Enter the invoice date before switching to ${LABEL[s.to]}: the VAT rate comes from it.` };
  }
  const convert = s.to === 'inclusive' ? grossUnitPrice : exVatUnitPrice;
  const converted = lines.map((l, i) => (readable(l.unitPrice) ? { ...l, unitPrice: convert(l.unitPrice, lineVatRate(s.types[i] ?? null, s.date)) } : l));
  for (let i = 0; i < lines.length; i++) {
    const before = formTotals([lines[i]!], [s.types[i] ?? null], s.from, s.date);
    const after = formTotals([converted[i]!], [s.types[i] ?? null], s.to, s.date);
    if (before.subtotal !== after.subtotal || before.tax !== after.tax) {
      const name = lines[i]!.description ? `"${lines[i]!.description}"` : `line ${i + 1}`;
      return { problem: `Switching to ${LABEL[s.to]} would change ${name} from ${formatCurrencyAmount(before.total, s.currencyCode ?? 'ZAR')} to `
        + `${formatCurrencyAmount(after.total, s.currencyCode ?? 'ZAR')}: its unit price cannot carry the VAT to the cent at that quantity. Change its quantity or price first, or keep ${LABEL[s.from]}.` };
    }
  }
  return { mode: s.to, lines: converted };
}
