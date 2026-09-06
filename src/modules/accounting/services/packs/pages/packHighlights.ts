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
import { toFinancialData } from './packScorecard';
import {
  PackFigureProvenance,
  type PackFigure,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { trendOption } from '@/modules/accounting/services/packs/packChartOptions';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import type { PackKpiDelta, PackKpiTile } from './packPageModel';

/** The tile's sparkline is inline-sized — the smallest of the pack's three
 *  chart heights (`CHART_HEIGHT_MM`), at a KPI-tile width. */
const SPARKLINE_SIZE = { widthMm: 60, heightMm: CHART_HEIGHT_MM.inline };

/** Percentage change of `current` against `prior`. Null when `prior` is zero
 *  — "changed by -100%… from what?" is as meaningless as dividing by it. */
function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  const value = ((current - prior) / Math.abs(prior)) * 100;
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/** `lowerIsBetter` is why this cannot be `value > 0` for every tile: debtor
 *  days and debt-to-equity rising is a WORSE period, and a green arrow on a
 *  lengthening debtor book is a false statement in the direction that
 *  flatters — the same failure class as AN-07 on the scorecard. */
function deltaFor(current: number, prior: number | null, lowerIsBetter: boolean): PackKpiDelta | null {
  if (prior === null) return null;
  const value = pctChange(current, prior);
  if (value === null) return null;
  return { value, basis: 'prior period', favourable: lowerIsBetter ? value < 0 : value > 0 };
}

function sparklineFor(points: PackTrendPoint[], series: (p: PackTrendPoint) => number): PackKpiTile['sparklineSvg'] {
  if (points.length === 0) return null;
  const trendPoints = points.map((point) => ({ label: point.label, value: series(point) }));
  return renderChartSvg(trendOption(trendPoints), SPARKLINE_SIZE);
}

function buildTile(
  label: string,
  figure: PackFigure,
  prior: number | null,
  sparklineSvg: PackKpiTile['sparklineSvg'],
  lowerIsBetter = false,
): PackKpiTile {
  return {
    label,
    figure,
    delta: figure.value === null ? null : deltaFor(figure.value, prior, lowerIsBetter),
    // No footnote index is allocated at this level — the page that assembles
    // this tile strip owns the page's `footnotes` array.
    trendFootnote: null,
    sparklineSvg,
  };
}

/** A ratio the engine may report as not meaningful — the reason is read from
 *  its own `notMeaningful` map, never invented here. */
function ratioFigure(
  p: PackFigureProvenance,
  source: string,
  value: number | null,
  format: 'ratio',
  reason: string | undefined,
): PackFigure {
  return value === null
    ? p.figure(source, null, format, reason ?? 'This ratio has no meaning on the current equity base.')
    : p.figure(source, value, format);
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

  const operatingProfit =
    current.operatingProfit === undefined
      ? p.figure(
          'packFigureSet.current.operatingProfit',
          null,
          'money',
          'No operating profit line was classified for this period.',
        )
      : p.figure('packFigureSet.current.operatingProfit', current.operatingProfit, 'money');

  // Same source string the scorecard reads these two from, deliberately: one
  // source issued twice with the SAME value is what `assertConsistent` is for,
  // and a second source name for the same field is how the headline tile and
  // the scorecard row start disagreeing without anything noticing.
  const leverage = ratioFigure(p, 'calculateExtendedRatios.debtToEquity', ratios.debtToEquity, 'ratio', ratios.notMeaningful.debtToEquity);
  const debtorDays = p.figure('calculateExtendedRatios.debtorDays', ratios.debtorDays, 'days');
  const workingCapital = p.figure('calculateExtendedRatios.workingCapital', ratios.workingCapital, 'money');

  return [
    buildTile('Revenue', revenue, prior?.revenue ?? null, sparklineFor(trend, (t) => t.revenue)),
    buildTile('Gross margin', grossMargin, prior ? marginPct(prior.revenue - prior.costOfSales, prior.revenue) : null, null),
    buildTile('Operating profit', operatingProfit, prior?.operatingProfit ?? null, null),
    buildTile('Net profit', netProfit, prior?.netProfit ?? null, sparklineFor(trend, (t) => t.netProfit)),
    buildTile('Cash', cash, prior?.cash ?? null, null),
    buildTile('Debt-to-equity', leverage, priorRatios?.debtToEquity ?? null, null, true),
    buildTile('Debtor days', debtorDays, priorRatios?.debtorDays ?? null, null, true),
    buildTile('Working capital', workingCapital, priorRatios?.workingCapital ?? null, null),
  ];
}
