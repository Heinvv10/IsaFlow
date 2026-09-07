/**
 * The board pack's headline KPI strip — the EIGHT figures spec §4.A page 3
 * names, not the forty-ratio grid: revenue, gross margin, operating profit,
 * net profit, cash, leverage, debtor days and one operational KPI. Each
 * carries a delta
 * against the prior period (never a zeroed comparative — R-P42's rule for
 * this page too) and, where a monthly series exists for it, a pre-rendered
 * sparkline.
 *
 * Nothing here computes a figure beyond a plain percentage-change and
 * `marginPct` (the one margin definition) — every base number is read
 * straight off `PackFigureSet`.
 */

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import {
  DEBTOR_DAYS_SOURCE,
  DEBT_TO_EQUITY_SOURCE,
  OPERATING_PROFIT_SOURCE,
  operatingProfitOf,
  readDebtToEquity,
  readDebtorDays,
  type PackMetricRead,
} from '@/modules/accounting/services/packs/figures/packMetricReads';
import type { PackFigureFormat } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { toFinancialData } from './packScorecard';
import {
  PackFigureProvenance,
  type PackFigure,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { sparklineOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import type { PackKpiTile } from './packPageModel';

/** The tile's sparkline is inline-sized — the smallest of the pack's three
 *  chart heights (`CHART_HEIGHT_MM`), at a KPI-tile width. */
const SPARKLINE_SIZE = { widthMm: 60, heightMm: CHART_HEIGHT_MM.inline };

/**
 * Percentage change of `current` against `prior`, through `marginPct` — the
 * repo's ONE percentage definition.
 *
 * This used to divide by `Math.abs(prior)`, which reports a movement off a
 * NEGATIVE base. The statement tables and every derived caption go through
 * `marginPct`, which refuses that base for the reason its own doc gives: the
 * sign of the result stops tracking the sign of the story. Two conventions in
 * one pack meant a tile and the table under it could describe the same
 * movement in opposite directions the moment a prior period ran at a loss —
 * this codebase already has a documented history of four competing margin
 * definitions, and this was a fifth.
 */
function pctChange(current: number, prior: number): number | null {
  return marginPct(current - prior, prior);
}

/**
 * The movement a tile shows, or WHY it shows none.
 *
 * The absence is returned rather than collapsed into a null, because the
 * three ways a delta can be missing are three different statements to a
 * director and the pack printed the strongest of them for all three: every
 * tile on the live demo pack read "No comparative period" while four
 * statement pages printed a prior column. The comparative was there; prior
 * revenue was nil and prior net profit was (905), so `marginPct` refused the
 * base. See `PackKpiDeltaAbsence`.
 *
 * `lowerIsBetter` is why `favourable` cannot be `value > 0` for every tile:
 * debtor days and debt-to-equity rising is a WORSE period, and a green arrow
 * on a lengthening debtor book is a false statement in the direction that
 * flatters — the same failure class as AN-07 on the scorecard.
 */
function movementFor(
  current: number | null,
  prior: number | null,
  lowerIsBetter: boolean,
  hasComparativePeriod: boolean,
): Pick<PackKpiTile, 'delta' | 'deltaAbsence'> {
  if (current === null) return { delta: null, deltaAbsence: 'noCurrentValue' };
  if (!hasComparativePeriod) return { delta: null, deltaAbsence: 'noComparativePeriod' };
  if (prior === null) return { delta: null, deltaAbsence: 'noPriorValue' };
  const value = pctChange(current, prior);
  if (value === null) return { delta: null, deltaAbsence: 'unusableBase' };
  return {
    delta: { value, basis: 'prior period', favourable: lowerIsBetter ? value < 0 : value > 0 },
    deltaAbsence: null,
  };
}

function sparklineFor(points: PackTrendPoint[], series: (p: PackTrendPoint) => number): PackKpiTile['sparklineSvg'] {
  if (points.length === 0) return null;
  const trendPoints = points.map((point) => ({ label: point.label, value: series(point) }));
  return renderChartSvg(sparklineOption(trendPoints), SPARKLINE_SIZE);
}

/**
 * Same as `sparklineFor`, for a series that can be not-meaningful in some
 * months (gross margin %, debtor days — both null on a no-revenue month,
 * R-P44/R-P45). Those months are dropped from the line rather than plotted
 * as a false zero; null when NO month has a meaningful value, same as an
 * empty trend.
 */
function sparklineForNullable(
  points: PackTrendPoint[],
  series: (p: PackTrendPoint) => number | null,
): PackKpiTile['sparklineSvg'] {
  const defined = points.filter((point) => series(point) !== null);
  if (defined.length === 0) return null;
  const trendPoints = defined.map((point) => ({ label: point.label, value: series(point) as number }));
  return renderChartSvg(sparklineOption(trendPoints), SPARKLINE_SIZE);
}

function buildTile(
  label: string,
  figure: PackFigure,
  prior: number | null,
  sparklineSvg: PackKpiTile['sparklineSvg'],
  hasComparativePeriod: boolean,
  lowerIsBetter = false,
): PackKpiTile {
  return {
    label,
    figure,
    ...movementFor(figure.value, prior, lowerIsBetter, hasComparativePeriod),
    // No footnote index is allocated at this level — the page that assembles
    // this tile strip owns the page's `footnotes` array.
    trendFootnote: null,
    sparklineSvg,
  };
}

/** Records a shared metric reading. The reading itself lives in
 *  `packMetricReads` because the scorecard shows two of these same metrics
 *  against the same provenance sources. */
function recordRead(
  p: PackFigureProvenance,
  source: string,
  read: PackMetricRead,
  format: PackFigureFormat,
): PackFigure {
  return read.value === null
    ? p.figure(source, null, format, read.unavailable ?? 'This metric could not be computed from the available figures.')
    : p.figure(source, read.value, format, undefined, read.basis);
}

export function buildHighlightTiles(
  set: PackFigureSet,
  trend: PackTrendPoint[],
  p: PackFigureProvenance,
): PackKpiTile[] {
  const { current, prior } = set;

  const revenue = p.figure('packFigureSet.current.revenue', current.revenue, 'money');
  const netProfit = p.figure('packFigureSet.current.netProfit', current.netProfit, 'money');
  const cash = p.figure('packFigureSet.current.cash', current.cash, 'money');

  const grossProfit = current.revenue - current.costOfSales;
  const grossMarginValue = marginPct(grossProfit, current.revenue);
  const grossMargin =
    grossMarginValue === null
      ? p.figure(
          'marginPct.grossMargin',
          null,
          'pct',
          'Revenue is not positive, so there is no turnover to take a margin of.',
        )
      : p.figure('marginPct.grossMargin', grossMarginValue, 'pct', undefined, {
          numerator: grossProfit,
          denominator: current.revenue,
        });

  const ratios = calculateExtendedRatios(toFinancialData(current));
  const priorRatios = prior ? calculateExtendedRatios(toFinancialData(prior)) : null;

  // Same sources and the same readings the scorecard uses, deliberately: one
  // source issued twice with the SAME value is what `assertConsistent` is for,
  // and a second reading of one source is how the headline tile and the
  // scorecard row start disagreeing — which throws, taking the render with it.
  const operatingProfit = p.figure(OPERATING_PROFIT_SOURCE, operatingProfitOf(current), 'money');
  const leverage = recordRead(p, DEBT_TO_EQUITY_SOURCE, readDebtToEquity(ratios, current), 'ratio');
  const debtorDays = recordRead(p, DEBTOR_DAYS_SOURCE, readDebtorDays(ratios, current), 'days');
  const workingCapital = p.figure('calculateExtendedRatios.workingCapital', ratios.workingCapital, 'money');

  // Whether a comparative PERIOD exists at all — the same fact
  // `buildBoardPackPages` derives `comparativePeriod` from, and the thing a
  // tile with no movement must not confuse with an unusable base.
  const hasComparative = prior !== null;

  return [
    buildTile('Revenue', revenue, prior?.revenue ?? null, sparklineFor(trend, (t) => t.revenue), hasComparative),
    buildTile('Gross margin', grossMargin, prior ? marginPct(prior.revenue - prior.costOfSales, prior.revenue) : null, sparklineForNullable(trend, (t) => t.grossMarginPct), hasComparative),
    // No monthly operating-profit series EXISTS, and the four bands that
    // would make one are not a substitute. `PackTrendPoint` carries turnover,
    // other income, cost of sales and the operating band, so the subtraction
    // is now available here — and taking it would be a page computing a
    // figure, which is the one thing the pack's provenance rule forbids:
    // `operatingProfitOf` prefers the classifier's OWN `operatingProfit`
    // where the ledger carries one, and a sparkline derived in this file
    // could silently disagree with the tile it sits beside. This tile stays
    // without one until the service issues the series.
    buildTile('Operating profit', operatingProfit, prior ? operatingProfitOf(prior) : null, null, hasComparative),
    buildTile('Net profit', netProfit, prior?.netProfit ?? null, sparklineFor(trend, (t) => t.netProfit), hasComparative),
    buildTile('Cash', cash, prior?.cash ?? null, sparklineFor(trend, (t) => t.cash), hasComparative),
    // No monthly totalEquity series exists — same reason as operating profit.
    buildTile('Debt-to-equity', leverage, priorRatios?.debtToEquity ?? null, null, hasComparative, true),
    buildTile('Debtor days', debtorDays, priorRatios && prior && prior.revenue > 0 ? priorRatios.debtorDays : null, sparklineForNullable(trend, (t) => t.debtorDays), hasComparative, true),
    // No monthly working-capital series exists — same reason as above.
    buildTile('Working capital', workingCapital, priorRatios?.workingCapital ?? null, null, hasComparative),
  ];
}
