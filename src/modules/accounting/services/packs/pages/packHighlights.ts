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
import { sharedDomain, sparklineOption } from '@/modules/accounting/services/packs/packLineChartOptions';
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

/** A sparkline, the window it covers and the domain it is drawn on, or nulls
 *  where there is no series. The three travel together because a line is only
 *  readable beside another line if a reader can see which months each of them
 *  holds AND which of them are drawn to one measure. */
type Sparkline = Pick<PackKpiTile, 'sparklineSvg' | 'sparklineWindow' | 'sparklineScale'>;

const NO_SPARKLINE: Sparkline = { sparklineSvg: null, sparklineWindow: null, sparklineScale: null };

/**
 * The MONEY tiles' one y-domain — the same rule, and the same function, page
 * 10 uses across its money panels.
 *
 * Taken over every rand series page 3 draws rather than per tile, so a small
 * movement is drawn small. `sharedDomain` also puts zero inside it, which is
 * what lets a reader see which side of break-even a line sits on: on the live
 * demo company cash is negative in every month of the window.
 *
 * A tile whose series is in another unit is NOT in here, and must not be — a
 * percentage and a rand amount on one axis is a category error, not a shared
 * scale.
 */
function moneyDomain(points: PackTrendPoint[]): { min: number; max: number } {
  return sharedDomain([
    points.map((p) => p.revenue),
    points.map((p) => p.netProfit),
    points.map((p) => p.cash),
  ]);
}

/** A money tile's line, on the domain every money tile shares. */
function sparklineFor(
  points: PackTrendPoint[],
  series: (p: PackTrendPoint) => number,
  domain: { min: number; max: number },
): Sparkline {
  if (points.length === 0) return NO_SPARKLINE;
  const trendPoints = points.map((point) => ({ label: point.label, value: series(point) }));
  return {
    sparklineSvg: renderChartSvg(sparklineOption(trendPoints, undefined, domain), SPARKLINE_SIZE),
    sparklineWindow: { plotted: points.length, of: points.length },
    sparklineScale: { ...domain, shared: true, unit: 'money' },
  };
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
  /** The unit its own axis is in — see `PackKpiTile.sparklineScale`. */
  unit: 'percentage' | 'days',
): Sparkline {
  const defined = points.filter((point) => series(point) !== null);
  if (defined.length === 0) return NO_SPARKLINE;
  const trendPoints = defined.map((point) => ({ label: point.label, value: series(point) as number }));
  const values = trendPoints.map((point) => point.value);
  return {
    sparklineSvg: renderChartSvg(sparklineOption(trendPoints), SPARKLINE_SIZE),
    sparklineWindow: { plotted: defined.length, of: points.length },
    // ITS OWN, AND RECORDED AS ITS OWN. These two series are a percentage and
    // a day count; there is no domain they could share with the rand lines,
    // so the tile says `shared: false` and the page's footnote names them.
    // The domain is what the axis actually took — `scale: true` on a series
    // with no zero in it, which is what an unstated `min`/`max` means.
    sparklineScale: { min: Math.min(...values), max: Math.max(...values), shared: false, unit },
  };
}

function buildTile(
  label: string,
  figure: PackFigure,
  prior: number | null,
  sparkline: Sparkline,
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
    ...sparkline,
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
  // ONE domain, read once and handed to all three money tiles. Computing it
  // inside `sparklineFor` would give three tiles three chances to disagree
  // about the scale they are said to share.
  const money = moneyDomain(trend);

  return [
    buildTile('Revenue', revenue, prior?.revenue ?? null, sparklineFor(trend, (t) => t.revenue, money), hasComparative),
    buildTile('Gross margin', grossMargin, prior ? marginPct(prior.revenue - prior.costOfSales, prior.revenue) : null, sparklineForNullable(trend, (t) => t.grossMarginPct, 'percentage'), hasComparative),
    // No monthly operating-profit series EXISTS, and the four bands that
    // would make one are not a substitute. `PackTrendPoint` carries turnover,
    // other income, cost of sales and the operating band, so the subtraction
    // is now available here — and taking it would be a page computing a
    // figure, which is the one thing the pack's provenance rule forbids:
    // `operatingProfitOf` prefers the classifier's OWN `operatingProfit`
    // where the ledger carries one, and a sparkline derived in this file
    // could silently disagree with the tile it sits beside. This tile stays
    // without one until the service issues the series.
    buildTile('Operating profit', operatingProfit, prior ? operatingProfitOf(prior) : null, NO_SPARKLINE, hasComparative),
    buildTile('Net profit', netProfit, prior?.netProfit ?? null, sparklineFor(trend, (t) => t.netProfit, money), hasComparative),
    buildTile('Cash', cash, prior?.cash ?? null, sparklineFor(trend, (t) => t.cash, money), hasComparative),
    // No monthly totalEquity series exists — same reason as operating profit.
    buildTile('Debt-to-equity', leverage, priorRatios?.debtToEquity ?? null, NO_SPARKLINE, hasComparative, true),
    buildTile('Debtor days', debtorDays, priorRatios && prior && prior.revenue > 0 ? priorRatios.debtorDays : null, sparklineForNullable(trend, (t) => t.debtorDays, 'days'), hasComparative, true),
    // No monthly working-capital series exists — same reason as above.
    buildTile('Working capital', workingCapital, priorRatios?.workingCapital ?? null, NO_SPARKLINE, hasComparative),
  ];
}
