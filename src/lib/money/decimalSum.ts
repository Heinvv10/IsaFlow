/**
 * Decimal-accurate money arithmetic for running balances.
 *
 * `let running = 0; running += debit - credit` accumulates in JS floating
 * point with no rounding, which is exact for a single add but drifts across a
 * long alternating sequence of debits/credits into payload values like
 * 126629.94999999995 or -4.3655745685100555e-11 for a line that nets to
 * zero. decimal.js is already a dependency (used by src/lib/amortisation);
 * this module gives services the same guarantee for running balances.
 *
 * No `Decimal.set` here: `Decimal` is a shared module-level singleton, and
 * src/lib/amortisation/{pmt,engine}.ts set the global rounding mode to
 * ROUND_HALF_UP for their own loan-schedule arithmetic (some of which — the
 * `.div()` calls in pmt.ts — relies on that global default rather than
 * passing a mode per call). Changing the global here would change loan
 * amortisation's rounding as a side effect of importing this module. Every
 * rounding call below passes its mode explicitly instead.
 */

import Decimal from 'decimal.js';

/**
 * Rounds to 2 decimal places and normalises -0 to 0. Use on every money
 * value a payload serialises, not only running balances — a figure read
 * from pg NUMERIC via `Number(...)` can already carry float noise past 2dp,
 * and JSON.stringify renders a large-enough drift in exponent notation
 * (e.g. -4.3655745685100555e-11) that no consumer expects.
 *
 * ROUND_HALF_CEIL (ties round toward +Infinity), not ROUND_HALF_UP (ties
 * round away from zero): the existing `round2` helpers this module sits
 * beside (gl/trialBalanceBasis.ts, gl/generalLedgerStreamTypes.ts) round via
 * `Math.round`, which rounds a tie toward +Infinity — `Math.round(-1.005)`
 * is `-1`, not `-1.01`. HALF_UP would disagree with them on every negative
 * half-cent and split the report family on which side of the balance sheet
 * a debtor's credit balance falls.
 */
export function toMoney(n: number): number {
  const rounded = new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_CEIL).toNumber();
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
