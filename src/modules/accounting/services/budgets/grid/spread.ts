/**
 * Row spreads and the wizard's uplift (decision 5). Integer cents in, integer
 * cents out. Every month but the last is rounded to the unit; the LAST month
 * takes the residue, so the months always sum to the target exactly. A total
 * smaller than about half a unit per month therefore lands whole on the last month.
 *
 * Targets: the spreads keep the total they are given (what the user typed);
 * `uplift`'s target is roundToUnit(ΣPY × (1 + pct/100)).
 *
 * Every result month is checked to be whole cents within NUMERIC(15,2), so an
 * `ok: true` result is always writable. One implementation for the client row
 * actions and the server wizard seed.
 */
import { type RoundingUnit, divRoundHalfAway, isCents } from './cents';

export type SpreadResult = { ok: true; months: number[] } | { ok: false; reason: string };

/** 1-15 months: a financial year (a change of year end makes a long one). */
export const MAX_MONTHS = 15;
/** Percentages (uplift, step growth) are carried to 4 decimal places as an exact ratio. */
const PCT_SCALE = 1_000_000n;
const MAX_PCT = 1000;
const TOO_LARGE = 'The result is larger than the biggest amount a budget month can hold.';

const refuse = (reason: string): SpreadResult => ({ ok: false, reason });

function badCount(n: number): string | null {
  return Number.isInteger(n) && n >= 1 && n <= MAX_MONTHS ? null : `A year has 1 to ${MAX_MONTHS} months, not ${n}.`;
}

function badCents(c: number): string | null {
  return isCents(c) ? null : `Not a budget amount in cents: ${c}.`;
}

/** Every month but the last from `rounded` (already unit multiples); the last takes target − Σ others. */
function residueLast(target: number, rounded: readonly number[]): SpreadResult {
  const out = rounded.slice(0, -1);
  out.push(target - out.reduce((s, x) => s + x, 0));
  if (!out.every(isCents)) return refuse(TOO_LARGE);
  return { ok: true, months: out.map(x => (x === 0 ? 0 : x)) };
}

/** numerator / (denominator × step), half away from zero, times `step`: exact, in BigInt. */
function toUnit(numerator: bigint, denominator: bigint, unit: RoundingUnit): number {
  const step = BigInt(unit * 100);
  return Number(divRoundHalfAway(numerator, denominator * step) * step);
}

/** (1 + pct/100) × PCT_SCALE, exact to 4 decimal places of pct. */
const pctFactor = (pct: number): bigint => PCT_SCALE + BigInt(Math.round(pct * 10_000));

export function spreadEven(totalCents: number, n: number, unit: RoundingUnit): SpreadResult {
  const bad = badCount(n) ?? badCents(totalCents);
  if (bad) return refuse(bad);
  return residueLast(totalCents, Array<number>(n).fill(toUnit(BigInt(totalCents), BigInt(n), unit)));
}

/** Shares by the prior year's monthly shape. PY must be one-signed and non-zero. */
export function spreadSeasonal(totalCents: number, pyCents: readonly number[], unit: RoundingUnit): SpreadResult {
  const bad = badCount(pyCents.length) ?? badCents(totalCents) ?? pyCents.map(badCents).find(Boolean);
  if (bad) return refuse(bad);
  const hasPos = pyCents.some(c => c > 0);
  const hasNeg = pyCents.some(c => c < 0);
  if (!hasPos && !hasNeg) return refuse('There is no prior-year activity to take a seasonal shape from.');
  if (hasPos && hasNeg) return refuse('The prior-year months have mixed signs, so they do not give a seasonal shape.');
  const pySum = pyCents.reduce((s, c) => s + BigInt(c), 0n);
  const total = BigInt(totalCents);
  // total × py / Σpy, rounded to the unit exactly (the product can pass 2^53).
  return residueLast(totalCents, pyCents.map(c => toUnit(total * BigInt(c), pySum, unit)));
}

/**
 * Month i weighted (1 + g)^i: a steady month-on-month growth, g in (-100%, 1000%].
 * Exact: weight_i = f^i × S^(n-1-i), where f = (1 + g) × S, is (1 + g)^i scaled by
 * the common S^(n-1), so the shares divide in BigInt like the other spreads.
 */
export function spreadStep(totalCents: number, n: number, growthPct: number, unit: RoundingUnit): SpreadResult {
  const bad = badCount(n) ?? badCents(totalCents);
  if (bad) return refuse(bad);
  if (!Number.isFinite(growthPct) || growthPct <= -100 || growthPct > MAX_PCT) {
    return refuse(`Monthly growth must be more than -100% and at most ${MAX_PCT}%.`);
  }
  const f = pctFactor(growthPct);
  const weights = Array.from({ length: n }, (_, i) => f ** BigInt(i) * PCT_SCALE ** BigInt(n - 1 - i));
  const wSum = weights.reduce((s, w) => s + w, 0n);
  const total = BigInt(totalCents);
  return residueLast(totalCents, weights.map(w => toUnit(total * w, wSum, unit)));
}

/** PY × (1 + pct/100) per month, pct in [-100, 1000]; target rounded to the unit. */
export function uplift(pyCents: readonly number[], pct: number, unit: RoundingUnit): SpreadResult {
  const bad = badCount(pyCents.length) ?? pyCents.map(badCents).find(Boolean);
  if (bad) return refuse(bad);
  if (!Number.isFinite(pct) || pct < -100 || pct > MAX_PCT) return refuse(`The uplift must be between -100% and ${MAX_PCT}%.`);
  const num = pctFactor(pct);
  const pySum = pyCents.reduce((s, c) => s + BigInt(c), 0n);
  const target = toUnit(pySum * num, PCT_SCALE, unit);
  if (!isCents(target)) return refuse(TOO_LARGE);
  // Each month's exact uplifted value (still scaled by PCT_SCALE), rounded to the unit in one division.
  return residueLast(target, pyCents.map(c => toUnit(BigInt(c) * num, PCT_SCALE, unit)));
}
