/**
 * What the invoice form's "Amounts are" choice does to a typed price. The price typed is the price sent and stored, in
 * every mode; the mode is sent with it (`amountsAre`, per-line VAT writer PR) and the server prices each line from it
 * (invoiceLineVatPricing). The quote modal still sends an ex-VAT price for an inclusive quote (customer-quotes/quoteFormVat.storedForm).
 *
 *   exclusive  the price typed is before VAT.
 *   none       as exclusive, at rate 0. The form keeps its rate, so leaving "none" brings it back.
 *   inclusive  the price typed is VAT-inclusive; the server backs each line's VAT out of its gross, so the stored total
 *              is exactly what was typed (it used to be sent as exVatUnitPrice(gross, rate), which drifted: 1 @ R10 incl
 *              stored R10.01, 3 @ R10 incl R30.02).
 *
 * Changing the mode changes how the prices read, not what they are: the shown price converts with the mode
 * (taxModeSwitch, exVatUnitPrice / grossUnitPrice), so it never reprices at the same rate and an untouched line saves as it was. A rate changed while
 * inclusive holds the gross. A 2-dp price always comes back exact at a rate of 0 or more: grossing up moves it at most
 * R0.005, and dividing by 1 + rate shrinks that below the half cent the way back rounds on. Below 0 the way back is not
 * exact, so nothing converts. That is per unit: the price rounds to the cent before its quantity multiplies it (1 000 x
 * R0.03 excl is R0.0345 incl, shown as R0.03), so the invoice pages convert through taxModeSwitch.switchTaxMode, each
 * line at its own rate, which refuses a change that would reprice a line.
 *
 * Pure: safe in a client bundle.
 */
import { parseDecimal } from '@/modules/accounting/services/shared/functionalAmounts';
import { previewLineAmount, previewTotals, toColumnCents } from '@/modules/accounting/services/ar/invoiceLineAmount';

export type TaxMode = 'exclusive' | 'inclusive' | 'none';

export const TAX_MODE_OPTIONS: { value: TaxMode; label: string }[] = [
  { value: 'exclusive', label: 'Excluding VAT' },
  { value: 'inclusive', label: 'Including VAT' },
  { value: 'none', label: 'No VAT' },
];

interface PricedLine { quantity: number; unitPrice: number; discount: number }

const readable = (...ns: number[]): boolean => ns.every((n) => Number.isFinite(n) && Math.abs(n) < 1e15);

/** `cents` numerator / denominator, to rands and cents, half away from zero, in exact decimal as numeric ROUND() does. */
function toRands(numerator: bigint, denominator: bigint): number {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const cents = (2n * magnitude + denominator) / (2n * denominator);
  return Number(numerator < 0n ? -cents : cents) / 100;
}

/**
 * `gross` × 100 / (100 + rate), to the cent. A field mid-edit (empty, NaN, a rate of -100) prices as 0 rather than
 * throwing, like previewLineAmount.
 */
export function exVatUnitPrice(gross: number, ratePercent: number): number {
  if (!readable(gross, ratePercent) || ratePercent <= -100) return 0;
  const g = parseDecimal(gross);
  const r = parseDecimal(ratePercent);
  const rateUnit = 10n ** BigInt(r.scale);
  const numerator = g.digits * 10_000n * rateUnit; // cents × the 100 of the VAT fraction
  const denominator = (100n * rateUnit + r.digits) * 10n ** BigInt(g.scale);
  return toRands(numerator, denominator);
}

/** ROUND(p × (100 + rate) / 100, 2), from the price as its column stores it. A field mid-edit is left as it is. */
export function grossUnitPrice(exVat: number, ratePercent: number): number {
  if (!readable(exVat, ratePercent)) return exVat;
  const p = parseDecimal(toColumnCents(exVat));
  const r = parseDecimal(ratePercent);
  const rateUnit = 10n ** BigInt(r.scale);
  return toRands(p.digits * (100n * rateUnit + r.digits), rateUnit * 10n ** BigInt(p.scale));
}

/** A price typed above zero that its numeric(…, 2) column would store as nothing (an invoice sends it as typed in every mode). */
export const pricesToNothing = (typed: number): boolean => readable(typed) && typed > 0 && toColumnCents(typed) === 0;

/** The refusal for such a line. */
export const pricesToNothingMessage = (description: string): string =>
  `"${description}" comes to under a cent - enter a higher price`;

/** The total the user typed in inclusive mode: each line's gross, after its discount. */
export const inclusiveTypedTotal = (lines: readonly PricedLine[]): number =>
  previewTotals(lines.map((l) => previewLineAmount(l.quantity, l.unitPrice, l.discount || 0)), 0).subtotal;

/** `default_vat_type` as it is compared: the column is free text. */
export const normaliseVatType = (vatType: string | null | undefined): string => (vatType ?? '').trim().toLowerCase();
