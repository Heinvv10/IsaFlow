/**
 * Deterministic captions and titles for pack pages.
 *
 * Every function here is `derived` in the approved/derived commentary split:
 * a pure string built from figures already on the pack, never model output.
 * A pack page a director forwards to a bank must never carry a sentence that
 * cannot be traced back to a number someone can check — that traceability is
 * the whole reason this file has no service call, no `Date.now()`, and no
 * branch that depends on anything but its arguments.
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
import { formatMoney, formatPctMagnitude } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type {
  PackChartSpec,
  PackKpiTile,
  PackScorecardGroup,
  PackTableRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';

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

export function highlightsTitle(set: PackFigureSet): string {
  const { current, prior } = set;
  let revenueClause: string;
  if (prior === null) {
    revenueClause = `Revenue is ${formatMoney(current.revenue)}, with no comparative period.`;
  } else {
    const change = pctChangeClause(current.revenue, prior.revenue);
    revenueClause = change === null
      ? noComparativeBaseSentence('Revenue', prior.revenue)
      : `Revenue ${change} against the prior period.`;
  }

  const margin = marginPct(current.operatingProfit ?? 0, current.revenue);
  const marginClause = margin === null
    ? NO_OPERATING_MARGIN_SENTENCE
    : `Operating margin is ${formatPctMagnitude(margin)}.`;

  return `${revenueClause} ${marginClause}`;
}

export function positionTitle(set: PackFigureSet): string {
  const equity = set.current.totalEquity;
  if (equity < 0) {
    return `Balance sheet position: negative equity of ${formatMoney(equity)}.`;
  }
  if (set.prior) {
    const change = pctChangeClause(equity, set.prior.totalEquity);
    if (change !== null) {
      return `Equity is ${change} to ${formatMoney(equity)}.`;
    }
  }
  return `Balance sheet position: equity of ${formatMoney(equity)}.`;
}

export function cashTitle(set: PackFigureSet): string {
  const cash = set.current.cash;
  if (set.prior === null) {
    return `Cash stands at ${formatMoney(cash)}, with no comparative period.`;
  }
  const change = pctChangeClause(cash, set.prior.cash);
  if (change === null) {
    return `Cash stands at ${formatMoney(cash)}; ${noComparativeBaseSentence('the comparative cash base', set.prior.cash, true)}`;
  }
  return `Cash is ${change} to ${formatMoney(cash)}.`;
}

export function scorecardTitle(met: number, total: number): string {
  return `Scorecard | ${met} of ${total} targets met`;
}

export function scorecardCaption(groups: PackScorecardGroup[]): string {
  const { met, total } = scorecardScore(groups);
  if (total === 0) {
    return 'No scorecard metric has a target to score against this period.';
  }
  const missed = total - met;
  const missedClause = missed > 0 ? `, with ${missed} missed` : '';
  return `${met} of ${total} scored targets were met this period${missedClause}.`;
}

export function largestMoverCaption(rows: PackTableRow[]): string {
  const movers = rows
    .filter((r) => r.role === 'line')
    .map((r) => ({ label: r.label, pct: r.figures.changePct?.value ?? null }))
    .filter((m): m is { label: string; pct: number } => m.pct !== null && Number.isFinite(m.pct));

  if (movers.length === 0) {
    return 'No line item shows a meaningful period-on-period movement.';
  }

  const largest = movers.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a));
  const direction = largest.pct >= 0 ? 'up' : 'down';
  return `${largest.label} moved the most, ${direction} ${formatPctMagnitude(largest.pct)}.`;
}

export function trendsCaption(panels: PackChartSpec[]): string {
  if (panels.length === 0) {
    return 'No trend panels are available this period.';
  }
  const noun = panels.length === 1 ? 'metric' : 'metrics';
  return `This page tracks ${panels.length} ${noun} over the period: ${panels.map((p) => p.title).join('; ')}.`;
}

/**
 * Page 4's title. The page itself carries the approved CEO commentary; this
 * is the conclusion above it, and it is derived so that a pack whose
 * commentary is still pending approval still gets a title that says
 * something about the period rather than the word "Commentary" — the exact
 * bare label the rejected pack shipped.
 */
export function narrativeTitle(set: PackFigureSet): string {
  const { current, prior } = set;
  const level = `Net profit of ${formatMoney(current.netProfit)}`;
  if (prior === null) return `${level} for the period, with no comparative.`;
  const change = pctChangeClause(current.netProfit, prior.netProfit);
  return change === null
    ? `${level}; ${noComparativeBaseSentence('the comparative profit base', prior.netProfit, true)}`
    : `${level}, ${change} on the prior period.`;
}

/** Page 5's title. Spec §4.A fixes the "Group results | …" prefix. */
export function resultsTitle(set: PackFigureSet): string {
  const { current } = set;
  const operating = current.operatingProfit ?? current.netProfit;
  const noun = operating < 0 ? 'operating loss' : 'operating profit';
  return `Group results | ${noun} of ${formatMoney(operating)} on revenue of ${formatMoney(current.revenue)}.`;
}

/**
 * Page 6's title — how the result was EARNED, so it reads the margin and the
 * cost base rather than restating the profit page 5 already led with.
 */
export function incomeStatementTitle(set: PackFigureSet): string {
  const { current } = set;
  const margin = marginPct(current.revenue - current.costOfSales, current.revenue);
  const costs = `operating expenses of ${formatMoney(current.operatingExpenses)}`;
  return margin === null
    ? `Revenue of ${formatMoney(current.revenue)} carries no meaningful margin base against ${costs}.`
    : `Gross margin of ${formatPctMagnitude(margin)} carried ${costs}.`;
}

/**
 * Page 10's title. `drawn` and `planned` are stated because spec §4.A asks
 * for six panels and the pack's trend series supports fewer — a title that
 * quietly said "trends" while drawing three of six would hide that from a
 * reader who cannot see what is missing.
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
 * How many scorecard targets were met, of those that could be scored.
 *
 * Lives beside `scorecardCaption`, which does the same counting, so page 9's
 * title and its caption cannot disagree about the score — two independent
 * counts of the same rows is exactly how a pack contradicts itself.
 */
export function scorecardScore(groups: PackScorecardGroup[]): { met: number; total: number } {
  const scored = groups
    .flatMap((g) => g.rows)
    .filter((r) => r.status === 'met' || r.status === 'missed');
  return { met: scored.filter((r) => r.status === 'met').length, total: scored.length };
}

/**
 * One derived line per highlight tile — spec §4.A page 3's "derived one-liner
 * per tile".
 *
 * It carries no formatted figure on purpose: the tile prints the value itself
 * three centimetres away, and a second rendering of the same number here is
 * how a pack ends up disagreeing with itself over rounding. What the tile
 * cannot say is the DIRECTION's meaning, which is what this adds.
 */
export function tileCaption(tile: PackKpiTile): string {
  if (tile.figure.value === null) {
    return `Not available. ${tile.figure.unavailable ?? ''}`.trim();
  }
  if (tile.delta === null) {
    return 'No comparative period, so no movement is shown against this figure.';
  }
  const direction = tile.delta.value >= 0 ? 'Up' : 'Down';
  const judgement = tile.delta.favourable ? 'a favourable' : 'an unfavourable';
  return `${direction} ${formatPctMagnitude(tile.delta.value)} on the ${tile.delta.basis} — ${judgement} movement.`;
}

/**
 * Page 7's caption. Deliberately NOT `positionTitle`, which is the page's own
 * heading: a commentary block that restates the title pads the page's density
 * with an echo, which is the opposite of what spec §5.7's three-block rule is
 * for. This says what the title does not — how the near-term obligations are
 * covered.
 */
export function positionCaption(set: PackFigureSet): string {
  const { currentAssets, currentLiabilities } = set.current;
  const workingCapital = currentAssets - currentLiabilities;
  const cover = marginPct(currentAssets, currentLiabilities);
  const coverClause = cover === null
    ? 'Current liabilities are not a positive base, so no cover percentage is meaningful'
    : `Current assets cover current liabilities ${formatPctMagnitude(cover)}`;
  return `${coverClause}; working capital stands at ${formatMoney(workingCapital)}.`;
}

/**
 * Page 8's caption, and the place the cash bridge's plug is explained.
 *
 * `residual` is the movement in cash the three captured categories do not
 * account for. The bridge draws it as a named bar so the chart foots; a
 * reader must be told it is unexplained rather than left to assume it is
 * something we measured.
 */
export function cashCaption(set: PackFigureSet, residual: number | null): string {
  const ocf = set.current.operatingCashFlow;
  const lead = ocf === undefined
    ? 'No operating cash flow figure was captured for this period.'
    : `Operating activities ${ocf >= 0 ? 'generated' : 'consumed'} ${formatMoney(Math.abs(ocf))}.`;
  if (residual === null || residual === 0) return lead;
  return `${lead} ${formatMoney(Math.abs(residual))} of the movement in cash is NOT explained by the operating, investing and financing figures the pack captures; the bridge shows it as an unexplained movement rather than closing the gap silently.`;
}

/**
 * Spec §3.5's mandatory negative-equity disclosure, in one place.
 *
 * `NegativeEquityBlock.tsx` renders this and the page model carries it, and a
 * second copy of a MANDATORY disclosure is how the two drift until one of
 * them stops matching what the pack actually shows.
 */
export function negativeEquitySentence(equity: number): string {
  return `Total equity is ${formatMoney(equity)}. Liabilities exceed assets by this amount, which may affect covenant compliance and the going-concern assessment.`;
}
