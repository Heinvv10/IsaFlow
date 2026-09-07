/**
 * Deterministic TITLES for pack pages, and the two disclosure sentences that
 * belong beside them. The block-level CAPTIONS moved to `derivedCaptions.ts`
 * when this file hit the 300-line ceiling and are re-exported at the bottom,
 * so every existing import path still resolves.
 *
 * Every function here is `derived` in the approved/derived commentary split:
 * a pure string built from figures already on the pack, never model output.
 * A pack page a director forwards to a bank must never carry a sentence that
 * cannot be traced back to a number someone can check — that traceability is
 * the whole reason this file has no service call, no `Date.now()`, and no
 * branch that depends on anything but its arguments.
 *
 * SCALE IS A REQUIRED ARGUMENT WHEREVER A FIGURE IS PRINTED (R-P52).
 * Scaling is a display concern owned by `formatMoney`; the model's figures
 * stay RAW so the integrity gate keeps comparing raw values. It was the
 * TABLES that were wired for the document's scale and the PROSE that was
 * not, so page 6 printed revenue as `99` under an `R'000` header and, three
 * centimetres below, "Revenue of 98 800" — the same figure, twice, a
 * thousand apart. A required parameter is what makes forgetting it a compile
 * error rather than a board pack a director misreads by three orders of
 * magnitude.
 *
 * Every percentage goes through `marginPct`, which returns null on a
 * non-positive base. That guard is reused here for period-on-period change,
 * not just for margins — a change measured off a negative or zero comparative
 * is exactly as meaningless as a margin on non-positive turnover, for the same
 * reason: the sign of the result stops tracking the sign of the story.
 *
 * Every percentage is rendered through `formatPctMagnitude`, the same
 * rounding convention `formatPct` uses for the tables beside these captions
 * — a hand-rolled `Math.round(...)+'%'` here would print "12%" in prose
 * against "+12.0%" in the table for the same change, which is the mixed
 * number-convention failure spec §7.1 criterion 8 exists to stop.
 */

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { formatMoney, formatPctMagnitude, type MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';

export {
  cashCaption,
  largestMoverCaption,
  positionCaption,
  scorecardCaption,
  scorecardScore,
  tileCaption,
  trendsCaption,
} from './derivedCaptions';

/**
 * The no-margin wording for THIS page's margin line, which reads operating
 * profit — not `reportPackService.ts`'s `NO_MARGIN_SENTENCE`, which names
 * net profit verbatim and has its own live caller there. Naming the wrong
 * line in a fallback sentence is the same false-statement defect this pack
 * was rejected for; the two constants must not be merged just because they
 * share a guard.
 */
const NO_OPERATING_MARGIN_SENTENCE =
  'There is no meaningful operating margin on non-positive turnover.';

/** "up 12.0%" / "down 7.0%", or null when the base is not usable. */
function pctChangeClause(current: number, prior: number): string | null {
  const pct = marginPct(current - prior, prior);
  if (pct === null) return null;
  const direction = pct >= 0 ? 'up' : 'down';
  return `${direction} ${formatPctMagnitude(pct)}`;
}

/**
 * The shared "no comparative base" clause, worded for `subject` as it reads
 * at the START of a sentence (capitalised). `midSentence` returns the same
 * wording lower-cased for use after a semicolon instead.
 */
function noComparativeBaseSentence(subject: string, base: number, midSentence = false): string {
  const s = base < 0
    ? `${subject} is measured against a negative comparative base, so the percentage change is not meaningful.`
    : `${subject} has no positive comparative base for a percentage change.`;
  return midSentence ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s;
}

export function highlightsTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current, prior } = set;
  let revenueClause: string;
  if (prior === null) {
    revenueClause = `Revenue is ${formatMoney(current.revenue, { scale })}, with no comparative period.`;
  } else {
    const change = pctChangeClause(current.revenue, prior.revenue);
    revenueClause = change === null
      ? noComparativeBaseSentence('Revenue', prior.revenue)
      : `Revenue ${change} against the prior period.`;
  }

  // `?? 0` here printed "Operating margin is 0.0%" on a page whose own tile
  // showed 750 000, because `operatingProfit` is OPTIONAL and a defaulted
  // zero is not the classifier saying the company broke even. One reading of
  // the operating line, `packMetricReads.operatingProfitOf`, for every page
  // and every sentence — a title that contradicts the figure beside it ships
  // silently, which is worse than the render failure it replaced.
  const margin = marginPct(operatingProfitOf(current), current.revenue);
  const marginClause = margin === null
    ? NO_OPERATING_MARGIN_SENTENCE
    : `Operating margin is ${formatPctMagnitude(margin)}.`;

  return `${revenueClause} ${marginClause}`;
}

export function positionTitle(set: PackFigureSet, scale: MoneyScale): string {
  const equity = set.current.totalEquity;
  if (equity < 0) {
    return `Balance sheet position: negative equity of ${formatMoney(equity, { scale })}.`;
  }
  if (set.prior) {
    const change = pctChangeClause(equity, set.prior.totalEquity);
    if (change !== null) {
      return `Equity is ${change} to ${formatMoney(equity, { scale })}.`;
    }
  }
  return `Balance sheet position: equity of ${formatMoney(equity, { scale })}.`;
}

export function cashTitle(set: PackFigureSet, scale: MoneyScale): string {
  const cash = set.current.cash;
  if (set.prior === null) {
    return `Cash stands at ${formatMoney(cash, { scale })}, with no comparative period.`;
  }
  const change = pctChangeClause(cash, set.prior.cash);
  if (change === null) {
    return `Cash stands at ${formatMoney(cash, { scale })}; ${noComparativeBaseSentence('the comparative cash base', set.prior.cash, true)}`;
  }
  return `Cash is ${change} to ${formatMoney(cash, { scale })}.`;
}

export function scorecardTitle(met: number, total: number): string {
  return `Scorecard | ${met} of ${total} targets met`;
}

/**
 * Page 4's title. The page itself carries the approved CEO commentary; this
 * is the conclusion above it, and it is derived so that a pack whose
 * commentary is still pending approval still gets a title that says
 * something about the period rather than the word "Commentary" — the exact
 * bare label the rejected pack shipped.
 */
export function narrativeTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current, prior } = set;
  const level = `Net profit of ${formatMoney(current.netProfit, { scale })}`;
  if (prior === null) return `${level} for the period, with no comparative.`;
  const change = pctChangeClause(current.netProfit, prior.netProfit);
  return change === null
    ? `${level}; ${noComparativeBaseSentence('the comparative profit base', prior.netProfit, true)}`
    : `${level}, ${change} on the prior period.`;
}

/** Page 5's title. Spec §4.A fixes the "Group results | …" prefix. */
export function resultsTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current } = set;
  // Was `?? current.netProfit`, which titled the page "operating profit of
  // 512 000" above a table row reading 750 000. Same defect as above: net
  // profit is a DIFFERENT line, not a fallback for this one.
  const operating = operatingProfitOf(current);
  const noun = operating < 0 ? 'operating loss' : 'operating profit';
  return `Group results | ${noun} of ${formatMoney(operating, { scale })} on revenue of ${formatMoney(current.revenue, { scale })}.`;
}

/**
 * Page 6's title — how the result was EARNED, so it reads the margin and the
 * cost base rather than restating the profit page 5 already led with.
 */
export function incomeStatementTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current } = set;
  const margin = marginPct(current.revenue - current.costOfSales, current.revenue);
  const costs = `operating expenses of ${formatMoney(current.operatingExpenses, { scale })}`;
  return margin === null
    ? `Revenue of ${formatMoney(current.revenue, { scale })} carries no meaningful margin base against ${costs}.`
    : `Gross margin of ${formatPctMagnitude(margin)} carried ${costs}.`;
}

/**
 * Page 10's title. `drawn` and `planned` are stated because spec §4.A asks
 * for six panels and the pack's trend series supports fewer — a title that
 * quietly said "trends" while drawing three of six would hide that from a
 * reader who cannot see what is missing.
 *
 * No scale: every figure in it is a percentage.
 */
export function trendsTitle(trend: PackTrendPoint[], drawn: number, planned: number): string {
  if (trend.length === 0) {
    return `No trend series covers this period, so 0 of ${planned} panels are drawn.`;
  }
  const first = trend[0]!.revenue;
  const last = trend[trend.length - 1]!.revenue;
  const change = pctChangeClause(last, first);
  const lead = change === null
    ? `Revenue has no usable base at the start of the ${trend.length}-period series`
    : `Revenue is ${change} across ${trend.length} periods`;
  return `${lead}; ${drawn} of ${planned} panels are drawn.`;
}

/**
 * Spec §3.5's mandatory negative-equity disclosure, in one place.
 *
 * `NegativeEquityBlock.tsx` renders this and the page model carries it, and a
 * second copy of a MANDATORY disclosure is how the two drift until one of
 * them stops matching what the pack actually shows.
 */
export function negativeEquitySentence(equity: number, scale: MoneyScale): string {
  return `Total equity is ${formatMoney(equity, { scale })}. Liabilities exceed assets by this amount, which may affect covenant compliance and the going-concern assessment.`;
}
