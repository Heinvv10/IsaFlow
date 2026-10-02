/**
 * Page 10's derived title. Moved out of `derivedSentences.ts` unchanged to
 * keep that file under the 300-line cap; `derivedSentences.ts` re-exports it,
 * so every existing import path still resolves.
 */

import type { MoneyScale } from '@/lib/format/money';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { monthLabel, wholeMonthsOf } from '@/modules/accounting/services/packs/pages/packPartialMonth';
import { money, pctChangeClause } from './derivedProseFigures';

/**
 * Page 10's title — WHAT THE SERIES DID, not how many panels the renderer
 * managed to draw.
 *
 * It ended "; 6 of 6 panels are drawn." (4 of 6 on Brightsphere). A count of
 * rendered panels is a rendering status: it belongs in a log, and on a sheet
 * going to non-executive directors it is the single line in this pack that
 * most obviously shows the machine. The count is not dropped — it moves to
 * the disclosure apparatus that already carries it: the page's caption opens
 * "6 metrics are tracked over the period", and where a measure is MISSING
 * the mandatory `Panels not drawn` block names how many could be drawn,
 * which of the six they are, and why.
 *
 * AND THE OTHER HALF WAS A CAVEAT WHERE A FINDING BELONGS. Where the first
 * month gives no usable base the lead read "Revenue has no usable base in
 * the first month of the 12-month series" — an explanation of a denominator
 * as a headline. The series still DID something over those months, and
 * saying so is both a finding and true: it runs from its first month's
 * figure to its last, which is the page's own first-to-last convention.
 *
 * No scale for the percentage branch; the level branch takes one, because
 * the two figures it prints are money.
 */
export function trendsTitle(
  series: PackTrendPoint[],
  scale: MoneyScale,
  /** How many measures this page tracks. Read ONLY by the empty-series
   *  branch, which has no figure of its own to state. */
  planned: number,
): string {
  // FIRST AND LAST WHOLE MONTH — the panels below draw nothing else, and a
  // two-day stub as "the last month" headlined Velocity Fibre's page as
  // "Revenue is down 100.0%". See `wholeMonthsOf`.
  const trend = wholeMonthsOf(series);
  if (trend.length === 0) {
    return `No monthly series covers this period, so none of the ${planned} measures `
      + 'this page tracks is drawn month by month.';
  }
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  const change = pctChangeClause(last.revenue, first.revenue);
  // NAMED WINDOW, not a bare percentage. "Revenue is up 1281.4% across 12
  // periods" sat against "Revenue has no positive comparative base for a
  // percentage change" on the highlights and group-results pages — the same
  // measure, two movements, and nothing saying that this one runs from the
  // first MONTH of the series to the last while that one covers the whole
  // period against the comparative. The page's own `Period` disclosure says
  // it in full; the title must not contradict it in the meantime.
  if (change !== null) {
    return `Revenue is ${change} from the first month of the ${trend.length}-month series to the last.`;
  }
  // The terminal month is NAMED, and marked where it is a stub — the same
  // marking every panel's own movement sentence carries, so a headline
  // quoting a seven-day month cannot read as a full one.
  if (first.revenue !== last.revenue) {
    return `Revenue runs from ${money(first.revenue, scale)} in ${monthLabel(first)} `
      + `to ${money(last.revenue, scale)} in ${monthLabel(last)}, `
      + `across the ${trend.length}-month series.`;
  }
  // ENDS THE SAME AS IT STARTED IS NOT "NOTHING HAPPENED", and on the one
  // company where this branch fires it is emphatically not: Brightsphere's
  // revenue is nil in the first month and nil in the last and (5 535) in
  // April, so "runs from nil to nil" would be a headline that hides the only
  // thing on the page worth reading. First-to-last is the page's convention
  // and it is the wrong sentence when the two are equal; the extreme is what
  // the series did.
  const extreme = trend.reduce((far, point) =>
    Math.abs(point.revenue - first.revenue) > Math.abs(far.revenue - first.revenue) ? point : far, first);
  if (extreme.revenue === first.revenue) {
    return `Revenue is ${money(first.revenue, scale)} in every month of the ${trend.length}-month series.`;
  }
  return `Revenue is ${money(first.revenue, scale)} in both the first and last of the ${trend.length} months, `
    // "reaches": "…, and (5 535) at its furthest" opened a clause on a
    // bracketed figure, which reads as a list marker.
    + `and reaches ${money(extreme.revenue, scale)} at its furthest, in ${monthLabel(extreme)}.`;
}
