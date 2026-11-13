/**
 * The days method (P6 spec §5, T2): a working-capital balance held as "D days
 * of the flow", walked back month by month.
 *
 *   closing = Σ_k flow[m−k] × clamp((D − Σ_{j<k} d[m−j]) / d[m−k], 0, 1)
 *
 * Every month fully inside D contributes its whole flow (exact, no rounding);
 * the one month D ends inside contributes its pro-rata share, rounded ONCE
 * half away from zero. Months before the series start read as 0 (the caller
 * warns via `walksPastStart`). Days are held in hundredths, so a fractional D
 * is exact too.
 */
import { checkedAdd, mulDiv, toHundredths } from './ratios';

/**
 * Closing balance at index `m` of `flows` (cents, oldest first: lookback then
 * version months) for `days` days, with `daysInMonth` aligned to `flows`.
 */
export function closingFromDays(days: number, flows: readonly number[], daysInMonth: readonly number[], m: number): number {
  let remaining = toHundredths(days);
  let closing = 0;
  for (let k = m; k >= 0 && remaining > 0; k--) {
    const d = (daysInMonth[k] ?? 0) * 100;
    const flow = flows[k] ?? 0;
    if (remaining >= d) {
      closing = checkedAdd(closing, flow);
      remaining -= d;
    } else {
      closing = checkedAdd(closing, mulDiv(flow, remaining, d));
      remaining = 0;
    }
  }
  return closing;
}

/** True when `days` reaches back before index 0 (the lookback is too short for it). */
export function walksPastStart(days: number, daysInMonth: readonly number[], m: number): boolean {
  let covered = 0;
  for (let k = m; k >= 0; k--) covered += (daysInMonth[k] ?? 0) * 100;
  return toHundredths(days) > covered;
}

/**
 * The pure derive (decision 10): balance ÷ trailing flow × trailing days, to
 * 2 dp. Null when the trailing flow is not positive (no basis to derive from).
 */
export function derivedDays(balance: number, trailingFlows: readonly number[], trailingDays: readonly number[]): number | null {
  const flow = trailingFlows.reduce((s, f) => s + f, 0);
  const days = trailingDays.reduce((s, d) => s + d, 0);
  if (flow <= 0) return null;
  return mulDiv(balance, days * 100, flow) / 100;
}
