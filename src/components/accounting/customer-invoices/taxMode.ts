/**
 * What the invoice form's "Amounts are" choice does to a typed price. An invoice stores only `tax_rate` and 2-dp ex-VAT
 * unit prices (invoiceLineAmount.ts), so the choice never reaches the API: it is a rate and a price by the time it is sent.
 *
 *   exclusive  the price typed is the price stored.
 *   none       as exclusive, at rate 0. The form keeps its rate, so leaving "none" brings it back.
 *   inclusive  the price typed is gross; the form sends exVatUnitPrice(gross, rate).
 *
 * Changing the mode changes how the prices read, not what they are: the shown price converts with the mode
 * (linesForModeChange), so an untouched line saves as it was. A 2-dp price always comes back exact at a rate of 0 or more:
 * grossing up moves it at most R0.005, and dividing by 1 + rate shrinks that below the half cent the way back rounds on.
 *
 * A converted price is rounded to the cent and the line is then priced from it, so an inclusive total can land off what
 * was typed by up to about qty x R0.00575 (3 @ R10 incl stores R30.02). The stored total is the invoice; the form shows
 * both figures whenever they differ (spec decision 2).
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

/** The rate the invoice is stored at. */
export const effectiveTaxRate = (mode: TaxMode, formRate: number): number => (mode === 'none' ? 0 : formRate);

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

/** What each line shows once the mode changes; `formRate` is the form's, since "none" keeps it. */
export function linesForModeChange<L extends { unitPrice: number }>(lines: readonly L[], from: TaxMode, to: TaxMode, formRate: number): L[] {
  if ((from === 'inclusive') === (to === 'inclusive')) return [...lines];
  const convert = to === 'inclusive' ? grossUnitPrice : exVatUnitPrice;
  return lines.map((l) => ({ ...l, unitPrice: convert(l.unitPrice, formRate) }));
}

/** The unit price the API receives for what was typed, at the invoice's effective rate. */
export const storedUnitPrice = (mode: TaxMode, typed: number, rate: number): number =>
  (mode === 'inclusive' ? exVatUnitPrice(typed, rate) : typed);

/** The line's stored ex-VAT amount for what was typed; a half-typed field previews as 0. */
export const lineTotalForMode = (mode: TaxMode, rate: number, l: PricedLine): number =>
  previewLineAmount(l.quantity, storedUnitPrice(mode, l.unitPrice, rate), l.discount || 0);

/** The total the user typed in inclusive mode: each line's gross, after its discount. */
export const inclusiveTypedTotal = (lines: readonly PricedLine[]): number =>
  previewTotals(lines.map((l) => previewLineAmount(l.quantity, l.unitPrice, l.discount || 0)), 0).subtotal;

/** The mode a customer's `default_vat_type` asks for, or null when it asks for none (the column is free text). */
export function taxModeFromVatType(vatType: string | null | undefined): TaxMode | null {
  if (vatType === 'zero' || vatType === 'exempt') return 'none';
  return vatType === 'standard' ? 'exclusive' : null;
}
