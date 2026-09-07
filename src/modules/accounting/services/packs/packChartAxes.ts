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
  /**
   * A NEUTRAL ramp, for a chart whose bands are CATEGORIES rather than
   * movements — the balance sheet's assets, liabilities and equity.
   *
   * Two failures, one cause. The composition bar took its bands from
   * `[ink, unfav, fav, prior]`, so on the demo pack negative equity of
   * (4 088) — the worst number in the document — was drawn as the largest
   * GREEN block on the sheet, in the same green sheet 6 uses for revenue and
   * other income. Colour was carrying the opposite of its meaning. And
   * because liabilities and equity were then separated by the red/green pair
   * alone, with no hatch, border or direct label, the sheet became two
   * identical mid-greys under a photocopier: the red and the green have
   * relative luminances of 83.5 and 99.4 out of 255, a six per cent
   * separation.
   *
   * The ramp is four steps of LIGHTNESS — 31, 110, 182 and 221 out of 255 —
   * so the bands stay distinguishable, and stay matchable to their legend
   * swatches, in black and white. It is the greyscale cue the rubric asks
   * for, carried by the colour itself rather than added beside it.
   *
   * Sheets 6 and 8 keep the semantic red and green, because there the colour
   * says which way a step MOVED and every bar is directly labelled with its
   * own value in the pack's bracket convention — a reader who cannot tell the
   * two greys apart still reads `(226)` on the bar.
   */
  categorical: readonly string[];
}

/**
 * The neutral ramp — see `ChartPalette.categorical`. Four steps of lightness
 * off the theme's own ink, so a photocopied band is still matchable to its
 * legend swatch. Not in `theme.ts`'s FALLBACK because that is the app's
 * semantic five and this is a categorical scale; the ink they start from is
 * the same one.
 */
const CATEGORICAL_BANDS = ['#15202b', '#5b7185', '#a9b8c4', '#d7dee4'] as const;

/** `axis` is the theme's `textTertiary`: the axis labels and ticks are the
 *  same grey as tertiary text everywhere else in the app. The other four map
 *  one-to-one. */
export const DEFAULT_CHART_PALETTE: ChartPalette = {
  ink: FALLBACK.ink,
  fav: FALLBACK.fav,
  unfav: FALLBACK.unfav,
  prior: FALLBACK.prior,
  axis: FALLBACK.textTertiary,
  categorical: CATEGORICAL_BANDS,
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
