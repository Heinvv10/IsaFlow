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
import type {
  PackChartSpec,
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
  const rows = groups.flatMap((g) => g.rows);
  const scored = rows.filter((r) => r.status === 'met' || r.status === 'missed');
  if (scored.length === 0) {
    return 'No scorecard metric has a target to score against this period.';
  }
  const met = scored.filter((r) => r.status === 'met').length;
  const missed = scored.length - met;
  const missedClause = missed > 0 ? `, with ${missed} missed` : '';
  return `${met} of ${scored.length} scored targets were met this period${missedClause}.`;
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
