/**
 * Decimal-accurate money arithmetic for running balances.
 *
 * `let running = 0; running += debit - credit` accumulates in JS floating
 * point with no rounding, which is exact for a single add but drifts across a
 * long alternating sequence of debits/credits into payload values like
 * 126629.94999999995 or -4.3655745685100555e-11 for a line that nets to
 * zero. decimal.js is already a dependency (used by src/lib/amortisation);
 * this module gives services the same guarantee for running balances.
 */

import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/** a + b, exact. */
export function moneyAdd(a: number, b: number): number {
  return new Decimal(a).plus(b).toNumber();
}

/** a - b, exact. */
export function moneySub(a: number, b: number): number {
  return new Decimal(a).minus(b).toNumber();
}

/**
 * Rounds to 2 decimal places, half-up, and normalises -0 to 0. Use on every
 * money value a payload serialises, not only running balances — a figure
 * read from pg NUMERIC via `Number(...)` can already carry float noise past
 * 2dp, and JSON.stringify renders a large-enough drift in exponent notation
 * (e.g. -4.3655745685100555e-11) that no consumer expects.
 */
export function toMoney(n: number): number {
  const rounded = new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  return rounded === 0 ? 0 : rounded;
}

/**
 * An accumulator for a running balance. Keeps full decimal precision
 * internally across `add`/`subtract` calls; `value` returns the running
 * total rounded to 2dp via `toMoney` so every emitted balance is already
 * payload-safe.
 */
export class RunningBalance {
  private total: Decimal;

  constructor(opening: number = 0) {
    this.total = new Decimal(opening);
  }

  add(n: number): number {
    this.total = this.total.plus(n);
    return this.value();
  }

  subtract(n: number): number {
    this.total = this.total.minus(n);
    return this.value();
  }

  value(): number {
    return toMoney(this.total.toNumber());
  }
}
