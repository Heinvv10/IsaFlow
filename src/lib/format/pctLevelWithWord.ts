/**
 * A PERCENTAGE LEVEL IN A SENTENCE — a margin, a cover — with its direction.
 *
 * `pctWithWord` says its nil word for any figure that ROUNDS to zero, which
 * is right for a change ("unchanged") and wrong for a level: page 12 defines
 * nil as a figure measured and nil, and a gross margin of 0.043% printed
 * "Gross margin is nil". A real level below one decimal is stated as a bound
 * with its direction — "a positive <0.1%" — the prose form of `belowPrecision`.
 * A measured zero is still the nil word.
 */
import { belowPrecision } from './belowPrecision';
import { pctWithWord, type ProsePct } from './money';

export function pctLevelWithWord(n: number, up: string, down: string, nil = 'nil', dp = 1): ProsePct {
  const bound = Number.isFinite(n) ? belowPrecision(Math.abs(n), dp, '%') : null;
  if (bound !== null) return `${n < 0 ? down : up} ${bound}` as ProsePct;
  return pctWithWord(n, up, down, nil, dp);
}
