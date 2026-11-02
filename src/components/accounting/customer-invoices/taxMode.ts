/**
 * What the invoice form's "Amounts are" choice does to a typed price. An invoice stores only `tax_rate` and 2-dp ex-VAT
 * unit prices (invoiceLineAmount.ts), so the choice never reaches the API: it is a rate and a price by the time it is sent.
 *
 *   exclusive  the price typed is the price stored.
 *   none       as exclusive, at rate 0. The form keeps its rate, so leaving "none" brings it back.
 *   inclusive  the price typed is gross; the form sends exVatUnitPrice(gross, rate).
 *
 * Changing the mode changes how the prices read, not what they are: the shown price converts with the mode
 * (linesForModeChange), so it never reprices at the same rate and an untouched line saves as it was. A rate changed while
 * inclusive holds the gross and moves the ex-VAT price. A 2-dp price always comes back exact at a rate of 0 or more:
 * grossing up moves it at most R0.005, and dividing by 1 + rate shrinks that below the half cent the way back rounds on.
 * Below 0 the way back is not exact, so nothing converts.
 *
 * A converted price is rounded to the cent, the line is priced from it, and the VAT is rounded on the subtotal, so an
 * inclusive total can land off what was typed by up to about qty x R0.00575 at 15%, plus a cent of VAT rounding
 * (1 @ R10 incl stores R10.01; 3 @ R10 incl stores R30.02). The stored total is the invoice; the form shows both figures
 * whenever they differ (spec decision 2).
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

/** What each line shows once the mode changes; `formRate` is the form's, since "none" keeps it. A price mid-edit is left as it is. */
export function linesForModeChange<L extends { unitPrice: number }>(lines: readonly L[], from: TaxMode, to: TaxMode, formRate: number): L[] {
  if ((from === 'inclusive') === (to === 'inclusive') || !readable(formRate) || formRate < 0) return [...lines];
  const convert = to === 'inclusive' ? grossUnitPrice : exVatUnitPrice;
  return lines.map((l) => (readable(l.unitPrice) ? { ...l, unitPrice: convert(l.unitPrice, formRate) } : l));
}

/** The unit price the API receives for what was typed, at the invoice's effective rate. */
export const storedUnitPrice = (mode: TaxMode, typed: number, rate: number): number =>
  (mode === 'inclusive' ? exVatUnitPrice(typed, rate) : typed);

/** A price typed above zero that its numeric(…, 2) column would store as nothing, in any mode. */
export const pricesToNothing = (mode: TaxMode, typed: number, rate: number): boolean =>
  readable(typed) && typed > 0 && toColumnCents(storedUnitPrice(mode, typed, rate)) === 0;

/** The refusal for such a line. */
export const pricesToNothingMessage = (description: string): string =>
  `"${description}" comes to under a cent - enter a higher price`;

/** The line's stored ex-VAT amount for what was typed; a half-typed field previews as 0. */
export const lineTotalForMode = (mode: TaxMode, rate: number, l: PricedLine): number =>
  previewLineAmount(l.quantity, storedUnitPrice(mode, l.unitPrice, rate), l.discount || 0);

/** The total the user typed in inclusive mode: each line's gross, after its discount. */
export const inclusiveTypedTotal = (lines: readonly PricedLine[]): number =>
  previewTotals(lines.map((l) => previewLineAmount(l.quantity, l.unitPrice, l.discount || 0)), 0).subtotal;

/** `default_vat_type` as it is compared: the column is free text. */
export const normaliseVatType = (vatType: string | null | undefined): string => (vatType ?? '').trim().toLowerCase();

/** The mode a customer's `default_vat_type` asks for, or null when it asks for none. */
export function taxModeFromVatType(vatType: string | null | undefined): TaxMode | null {
  const v = normaliseVatType(vatType);
  if (v === 'zero' || v === 'exempt') return 'none';
  return v === 'standard' ? 'exclusive' : null;
}

const NO_VAT_CUSTOMER: Record<string, string> = { zero: 'zero-rated', exempt: 'VAT exempt' };

/** What to tell the user when the customer's VAT type conflicts with the rate the invoice is stored at. Their choice stands. */
export function vatTypeWarning(vatType: string | null | undefined, effectiveRate: number): string | undefined {
  const v = normaliseVatType(vatType);
  if (!v) return undefined;
  const noVat = NO_VAT_CUSTOMER[v];
  if (noVat) return effectiveRate === 0 ? undefined : `This customer is ${noVat}, but this invoice charges VAT at ${effectiveRate}%.`;
  if (v === 'standard') return effectiveRate === 0 ? 'This customer is standard-rated, but this invoice charges no VAT.' : undefined;
  return `This customer's VAT type "${v}" is not one IsaFlow knows: check the VAT on this invoice.`;
}
