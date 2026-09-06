/**
 * The board pack's headline KPI strip — four figures, not the forty-ratio
 * grid: revenue, net profit, gross margin, cash. Each carries a delta
 * against the prior period (never a zeroed comparative — R-P42's rule for
 * this page too) and, where a monthly series exists for it, a pre-rendered
 * sparkline.
 *
 * Nothing here computes a figure beyond a plain percentage-change and
 * `marginPct` (the one margin definition) — every base number is read
 * straight off `PackFigureSet`.
 */

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
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

function deltaFor(current: number, prior: number | null): PackKpiDelta | null {
  if (prior === null) return null;
  const value = pctChange(current, prior);
  if (value === null) return null;
  return { value, basis: 'prior period', favourable: value > 0 };
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
): PackKpiTile {
  return {
    label,
    figure,
    delta: figure.value === null ? null : deltaFor(figure.value, prior),
    // No footnote index is allocated at this level — the page that assembles
    // this tile strip owns the page's `footnotes` array.
    trendFootnote: null,
    sparklineSvg,
  };
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

  return [
    buildTile('Revenue', revenue, prior?.revenue ?? null, sparklineFor(trend, (t) => t.revenue)),
    buildTile('Net profit', netProfit, prior?.netProfit ?? null, sparklineFor(trend, (t) => t.netProfit)),
    buildTile('Gross margin', grossMargin, prior ? marginPct(prior.revenue - prior.costOfSales, prior.revenue) : null, null),
    buildTile('Cash', cash, prior?.cash ?? null, null),
  ];
}
