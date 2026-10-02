/**
 * Page 10's scale arithmetic, taken on the figures the sheet PRINTS — the
 * printed span of a domain, a panel's share of it, and what a dropped point
 * gives up. Moved out of `packTrendCharts.ts` unchanged to keep that file
 * under the 300-line cap.
 */

import { formatMoney, inProse, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import type { Domain } from './packTrendScale';

/**
 * A FIGURE AS THE SHEET PRINTS IT, in the scale's own units.
 *
 * Page 10 invites the reader to check a share off the sheet — every panel
 * labels the ends of its own axis and the note states the shared span — and
 * the invitation did not survive the arithmetic. The shares were computed on
 * raw rands and the axes print thousands: an operating-expenses range of
 * 58 452 over a shared span of 3 528 000 is 1.66%, printed 1.7%, while the
 * reader divides the 58 and the 3 528 in front of them and gets 1.6%. The
 * figure was not wrong; the check the page asked for did not reproduce, and
 * on a page whose whole argument is that its scales are checkable that is
 * the more expensive of the two.
 *
 * So every number in that arithmetic is now the number the reader can see:
 * the shared span is the difference of the two PRINTED extremes (not a
 * separately rounded difference, which is how "1 908" and "(1 621)" came to
 * be published beside a span of 3 528 rather than 3 529), and each panel's
 * share is its own printed range over that. Nothing else moves — which
 * panels sit on the shared scale is still decided on the unrounded spans in
 * `packTrendScale`, because a threshold that wobbles with a rounding is a
 * threshold that changes a drawing for no reason.
 */
function atScale(value: number, scale: MoneyScale): number {
  const divisor = MONEY_SCALES[scale];
  // Away from zero at the half, which is what `Intl.NumberFormat` does and
  // `Math.round` does not for a negative.
  return Math.sign(value) * Math.round(Math.abs(value) / divisor);
}

/** The printed span of a domain, in the scale's units. */
export function printedSpan(domain: Domain, scale: MoneyScale): number {
  return atScale(domain.max, scale) - atScale(domain.min, scale);
}

/** A panel's own printed range as a percentage of the printed shared span,
 *  to one decimal — the number the panel's title states, reproducible from
 *  the four figures the sheet prints. */
export function printedSharePct(own: Domain, sharedSpan: number, scale: MoneyScale): number {
  if (sharedSpan === 0) return 100;
  return Math.round((printedSpan(own, scale) / sharedSpan) * 1000) / 10;
}

/** A domain as the sheet prints its two ends — "(1 621) to 59". The same two
 *  numbers the shared range is stated with, through the same formatter. */
export function printedRange(domain: Domain, scale: MoneyScale): string {
  return `${inProse(formatMoney(domain.min, { scale }))} to `
    + `${inProse(formatMoney(domain.max, { scale }))}`;
}

/** How much of the printed shared span the printed residual range gives up,
 *  to one decimal — the subtraction a reader does on the sheet. */
export function printedShrinkPct(sharedSpan: number, residual: Domain, scale: MoneyScale): number {
  if (sharedSpan === 0) return 0;
  return Math.round(((sharedSpan - printedSpan(residual, scale)) / sharedSpan) * 1000) / 10;
}
