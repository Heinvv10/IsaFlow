/**
 * The pieces every pack chart shares: the palette, the money y-axis, and the
 * two tooltip formatters.
 *
 * A sibling of `packChartOptions.ts` only because that file is at the repo's
 * 300-line ceiling — giving each chart the document's scale is what pushed it
 * over. Nothing here decides what a chart LOOKS like beyond its axis; the
 * option builders next door still own that.
 *
 * SECURITY: ECharts renders a tooltip formatter's return value as HTML, and
 * every label passed in is ledger-sourced text (an account or step name), so
 * both formatters escape before interpolating — see `escapeHtml.ts`.
 */
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { FALLBACK } from '@/lib/charts/theme';
import { escapeHtml } from './escapeHtml';

/** The shape of an ECharts tooltip-formatter callback param this module
 *  actually reads. Declared locally: `echarts/core` does not export its
 *  internal `CallbackDataParams` / `TopLevelFormatterParams` types. */
export interface TooltipDataParam {
  dataIndex: number;
  seriesName?: string;
  value?: number;
}
export type TopLevelFormatterParams = TooltipDataParam | TooltipDataParam[];

export interface ChartPalette {
  ink: string;
  fav: string;
  unfav: string;
  prior: string;
  axis: string;
}

/** `axis` is the theme's `textTertiary`: the axis labels and ticks are the
 *  same grey as tertiary text everywhere else in the app. The other four map
 *  one-to-one. */
export const DEFAULT_CHART_PALETTE: ChartPalette = {
  ink: FALLBACK.ink,
  fav: FALLBACK.fav,
  unfav: FALLBACK.unfav,
  prior: FALLBACK.prior,
  axis: FALLBACK.textTertiary,
};

export function axisDomain(values: number[]): { min: number; max: number } {
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
}

/**
 * The y-axis of a MONEY chart, at the DOCUMENT's scale.
 *
 * `formatter` is the whole point. ECharts' default axis label is
 * `String(value)`, so a chart under an `R'000` page header drew ticks in raw
 * rands running to `-1,500,000` beside a table cell reading `(1 332)` — the
 * same figure, on one page, a thousand apart. It is also where the printed
 * tick `-532,331.6000000001` came from: a float tick has no reason to be
 * round, and `String` prints all of it.
 *
 * The axis `name` carries the scale, so the chart states its own units
 * instead of borrowing the caption of whatever table happens to sit above it.
 */
export function moneyValueAxis(
  palette: ChartPalette,
  scale: MoneyScale,
  domain?: { min: number; max: number },
) {
  return {
    type: 'value' as const,
    ...(domain ?? {}),
    name: scale,
    nameLocation: 'end' as const,
    nameTextStyle: { color: palette.axis },
    axisLabel: { color: palette.axis, formatter: (value: number) => formatMoney(value, { scale }) },
    axisLine: { lineStyle: { color: palette.axis } },
    splitLine: { lineStyle: { color: palette.prior } },
  };
}

function firstParam(params: TopLevelFormatterParams): TooltipDataParam | undefined {
  return Array.isArray(params) ? params[0] : params;
}

/** The tooltip printed the raw number — `1234567.89` where the bar's own
 *  label, the statement three centimetres away and the deck all said
 *  "1 234 568". Same figure, three renderings, and the one a reader hovers to
 *  CHECK a number was the odd one out. `formatMoney` is the app's single
 *  money formatting rule; a negative comes back in parentheses like every
 *  other statement figure, and at the document's scale like every other one. */
export function labelTooltipFormatter(labels: string[], values: number[], scale: MoneyScale) {
  return (params: TopLevelFormatterParams): string => {
    const idx = firstParam(params)?.dataIndex ?? 0;
    const label = labels[idx] ?? '';
    const value = values[idx] ?? 0;
    return `${escapeHtml(label)}: ${formatMoney(value, { scale })}`;
  };
}

/** A stacked composition bar's tooltip: every band under the cursor, named
 *  and formatted at the document's scale. */
export function compositionTooltip(scale: MoneyScale) {
  return (params: TopLevelFormatterParams): string => {
    const list = Array.isArray(params) ? params : [params];
    return list
      .map((p) => `${escapeHtml(p.seriesName ?? '')}: ${formatMoney(Number(p.value ?? 0), { scale })}`)
      .join('<br/>');
  };
}
