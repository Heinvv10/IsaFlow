/**
 * Exact integer-cent ratio arithmetic for the three-way engine.
 *
 * Every product of cents and a rate is computed in BigInt and rounded ONCE,
 * half away from zero (the programme's rule, `grid/cents.divRoundHalfAway`).
 * Shares are held in parts per million and days in hundredths, so no float
 * product ever reaches a cent.
 */
import { divRoundHalfAway } from '@/modules/accounting/services/budgets/grid/cents';
import { EngineInputError } from './errors';

/**
 * The SA standard rate in basis points (15 %). Pinned equal to the reports
 * module's rate constant by test: that module imports the database layer, so
 * this pure engine cannot import it.
 */
export const SA_STANDARD_RATE_BP = 1500;

/**
 * Engine money bounds (fix round 1). One value ≤ R100 bn (1e13 cents); Σ|every
 * money input| ≤ R10 tn (1e15). Every bucket and flow is a signed sum of input
 * cents, VAT (≤ 15 %) and residuals that re-add them, so it stays within a small
 * multiple of the total: far below 2^53 ≈ 9.007e15. `checkedAdd` is the backstop.
 */
export const MAX_VALUE_CENTS = 10_000_000_000_000;
export const MAX_TOTAL_CENTS = 1_000_000_000_000_000;

/** a + b, refused as RANGE when the result is not a safe integer. */
export function checkedAdd(a: number, b: number): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw new EngineInputError('RANGE', `Sum left the safe-integer range: ${a} + ${b}`);
  return s;
}

export const PPM = 1_000_000;
const BP = 10_000;

/** A 0..1 share as integer parts per million. */
export function toPpm(share: number): number {
  return Math.round(share * PPM);
}

/** A day count as integer hundredths of a day. */
export function toHundredths(days: number): number {
  return Math.round(days * 100);
}

/** round(a × num / den), half away from zero, exact. */
export function mulDiv(a: number, num: number | bigint, den: number | bigint): number {
  if (!Number.isSafeInteger(a)) throw new RangeError(`Not whole cents: ${a}`);
  const out = Number(divRoundHalfAway(BigInt(a) * BigInt(num), BigInt(den)));
  if (!Number.isSafeInteger(out)) throw new RangeError(`Cents overflow: ${out}`);
  return out === 0 ? 0 : out;
}

/** Output/input VAT on an ex-VAT amount of which `sharePpm` is standard-rated. */
export function vatOnNet(netCents: number, sharePpm: number): number {
  return mulDiv(netCents, BigInt(sharePpm) * BigInt(SA_STANDARD_RATE_BP), BigInt(PPM) * BigInt(BP));
}

/**
 * The VAT inside a VAT-inclusive amount whose ex-VAT base is `sharePpm`
 * standard-rated: gross × s·r / (1 + s·r). At s = 1 this is the familiar
 * gross × 15/115; for s < 1 it is the exact inverse of `vatOnNet`.
 */
export function vatInGross(grossCents: number, sharePpm: number): number {
  const sr = BigInt(sharePpm) * BigInt(SA_STANDARD_RATE_BP);
  return mulDiv(grossCents, sr, BigInt(PPM) * BigInt(BP) + sr);
}
