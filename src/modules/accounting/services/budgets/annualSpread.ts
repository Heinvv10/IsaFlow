/**
 * An annual budget amount spread over a financial year's months (PURE; the MCP set_budget_annual tool).
 * One implementation of the rounding rule (decision 5): every month but the last is rounded to the unit
 * and the LAST month takes the residue, so the months sum to the annual amount exactly; the spreads are
 * the grid's own (`grid/spread`).
 *  - flat:       evenly (`spreadEven`);
 *  - prior_year: in proportion to the same calendar months a year earlier (`spreadSeasonal`): refused when
 *                the prior year has no activity or its months have mixed signs, never guessed;
 *  - weights:    one non-negative whole-number weight per month (`splitByWeights`).
 */
import type { RoundingUnit } from './grid/cents';
import { splitByWeights, spreadEven, spreadSeasonal, type SpreadResult } from './grid/spread';

export type AnnualSpread =
  | { kind: 'flat' }
  | { kind: 'prior_year'; priorCents: readonly number[] }
  | { kind: 'weights'; weights: readonly number[] };

export function spreadAnnual(totalCents: number, monthCount: number, spread: AnnualSpread, unit: RoundingUnit): SpreadResult {
  if (spread.kind === 'flat') return spreadEven(totalCents, monthCount, unit);
  if (spread.kind === 'prior_year') {
    if (spread.priorCents.length !== monthCount) return { ok: false, reason: 'The prior year does not cover this year\'s months.' };
    return spreadSeasonal(totalCents, spread.priorCents, unit);
  }
  if (spread.weights.length !== monthCount) return { ok: false, reason: `Give one weight per month: this year has ${monthCount} months.` };
  if (spread.weights.some((w) => !Number.isSafeInteger(w) || w < 0)) return { ok: false, reason: 'Each weight must be a whole number of 0 or more.' };
  const split = splitByWeights(totalCents, spread.weights, unit);
  return split.ok ? { ok: true, months: split.parts } : split;
}
