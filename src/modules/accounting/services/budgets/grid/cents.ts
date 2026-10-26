/**
 * Budget grid money is integer cents. Rand values are converted once at the
 * edge (`toCents`), every sum after that is an integer sum, and rounding to a
 * whole-rand unit (decision 5: R1, R100, R1000) is integer arithmetic.
 *
 * Half away from zero throughout, on the DECIMAL value, as NUMERIC(15,2)
 * rounds (`core/budgetMonths.round2`, which `toCents` reuses).
 */
import { round2 } from '@/modules/accounting/services/core/budgetMonths';
import { MAX_MONEY } from '@/lib/money/wholeCents';

export type RoundingUnit = 1 | 100 | 1000;

export const ROUNDING_UNITS: readonly RoundingUnit[] = [1, 100, 1000];

/** The largest amount a NUMERIC(15,2) budget cell holds, in cents. */
export const MAX_CENTS = Math.round(MAX_MONEY * 100);

export const isCents = (c: number): boolean => Number.isSafeInteger(c) && Math.abs(c) <= MAX_CENTS;

/** Rand → integer cents (1.005 is 101). Refuses a non-finite amount or one beyond NUMERIC(15,2). */
export function toCents(rand: number): number {
  if (!Number.isFinite(rand) || Math.abs(rand) > MAX_MONEY) throw new RangeError(`Not a budget amount: ${rand}`);
  const cents = Math.round(round2(rand) * 100);
  return cents === 0 ? 0 : cents;
}

/** Integer cents → rand, for the wire (NUMERIC(15,2) reads it exactly). */
export function fromCents(cents: number): number {
  const rand = cents / 100;
  return rand === 0 ? 0 : rand;
}

/** `a / b` for integers, rounded half away from zero, exactly (BigInt). */
export function divRoundHalfAway(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('Division by zero');
  const negative = (a < 0n) !== (b < 0n);
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (2n * absA + absB) / (2n * absB);
  return negative ? -q : q;
}

/** Integer cents rounded to a multiple of `unit` rand, half away from zero. */
export function roundToUnit(cents: number, unit: RoundingUnit): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Not whole cents: ${cents}`);
  if (!ROUNDING_UNITS.includes(unit)) throw new RangeError(`Unknown rounding unit: ${unit}`);
  const step = BigInt(unit * 100);
  const out = Number(divRoundHalfAway(BigInt(cents), step) * step);
  return out === 0 ? 0 : out;
}
