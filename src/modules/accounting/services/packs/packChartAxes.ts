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
  /** The sheet the chart is printed on. A bar label that has no room above
   *  its bar is drawn INSIDE it (see `packChartOptions`), and in `ink` on an
   *  ink-filled total bar that label is invisible — which is how sheets 6
   *  and 8 came to print Gross Profit, Net Profit and both cash totals with
   *  no value on them at all, leaving hue as the only thing separating an
   *  increase from a decrease on the largest marks in the pack. */
  paper: string;
}

/**
 * The neutral ramp — see `ChartPalette.categorical`. Four steps of lightness
 * off the theme's own ink, so a photocopied band is still matchable to its
 * legend swatch. Not in `theme.ts`'s FALLBACK because that is the app's
 * semantic five and this is a categorical scale; the ink they start from is
 * the same one.
 */
const CATEGORICAL_BANDS = ['#15202b', '#5b7185', '#a9b8c4', '#d7dee4'] as const;

/**
 * THE INCOME AND COST INKS ARE SEPARATED BY LIGHTNESS, NOT ONLY BY HUE.
 *
 * The app's semantic pair is `#1f7a4d` and `#b23a3a`, and on a screen they
 * are unmistakable. Desaturated they are not: their relative luminances are
 * 99.4 and 83.5 out of 255, a six per cent separation, so sheet 6's green
 * revenue bar and red cost-of-sales bar RESOLVE TO THE SAME MID-GREY. A
 * board pack is photocopied, faxed to a bank and printed on a mono office
 * device, and in every one of those a reader was left with bar direction and
 * the printed labels alone.
 *
 * These two keep the hues — income is green and cost is red in every pack
 * this platform prints, and that convention is stated on the basis page —
 * and put a real step of lightness between them: ink 30.5, cost 66.8, income
 * 129.2 out of 255, which is the same kind of lightness ramp
 * `ChartPalette.categorical` uses for the balance sheet's three bands. Cost
 * sits between the two, which is also the right weight for it: the darkest
 * ink stays the subtotal, the mark a reader's eye should land on.
 *
 * BOTH ARE STILL FILLS ON WHITE PAPER, which is the constraint that decides
 * how far apart they can go. A fill needs 3:1 against the sheet to read as a
 * shape at all; income at `#2e9d63` is 3.43:1 and anything lighter stops
 * being a bar. The bar LABEL is what gave way instead — see
 * `labelInkOn` in `packChartOptions.ts`, which picks paper or ink by
 * contrast rather than assuming paper reads on every fill.
 *
 * Not in `theme.ts`'s FALLBACK: that is the app's on-screen semantic pair and
 * nothing about a screen is photocopied. This is the PRINT palette.
 *
 * `ink` and `prior` map one-to-one to the theme's.
 *
 * `axis` NO LONGER DOES, AND THAT IS THE POINT. It was the theme's
 * `textTertiary`, `#9ca3af` — 2.54:1 on paper, and 2.16:1 as an eight-point
 * panel label once the rasteriser has thinned the strokes. Tertiary text on a
 * screen is a hint a reader can ignore; on this pack it is the only evidence
 * for the claims the sheets make about themselves. Page 10 states that a
 * rescaled panel prints its own axis at both ends and quotes 37, 58, 1 908
 * and (1 621) — figures that appear NOWHERE ELSE IN THE PACK — so the sheet
 * earns its claim and then sets the proof of it at half the contrast of its
 * own footnotes. The zero end is a bare en dash at that weight, which is
 * effectively nothing.
 *
 * `#5f6b7a` is 5.43:1, clear of the 4.5:1 a line of eight-point type needs
 * with room for the thinning, and still recedes behind `ink` at 16.5:1 —
 * which is what an axis is for. The gridlines keep `prior`: a hairline rule
 * is not type, and darkening every one of them changes what the charts are
 * rather than what can be read off them.
 */
const PRINT_FAV = '#2e9d63';
const PRINT_UNFAV = '#8c2f2f';
const PRINT_AXIS = '#5f6b7a';

export const DEFAULT_CHART_PALETTE: ChartPalette = {
  ink: FALLBACK.ink,
  fav: PRINT_FAV,
  unfav: PRINT_UNFAV,
  prior: FALLBACK.prior,
  axis: PRINT_AXIS,
  categorical: CATEGORICAL_BANDS,
  paper: '#ffffff',
};

/** A value axis's bounds and the number of gridline steps between them.
 *  Every field is an ECharts `yAxis` property, so `moneyValueAxis` spreads
 *  the whole object. */
export interface AxisDomain { min: number; max: number; splitNumber: number }

/**
 * A ROUND TICK STEP, chosen the way a hand-drawn axis chooses one: the
 * 1/2/5×10ⁿ closest to the span divided by the number of steps asked for.
 */
function niceStep(span: number, intervals: number): number {
  const rough = span / intervals;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const error = rough / power;
  const factor = error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
  return factor * power;
}

/**
 * THE DOMAIN IS ROUNDED OUT TO THE NEXT WHOLE GRIDLINE, WHICH IS WHAT MAKES
 * AN AXIS READ AS AN AXIS.
 *
 * It used to clamp exactly to the data, and both failure modes reached
 * paper. Where the extreme was not round — the demo cash bridge closing at
 * (548) — ECharts kept the domain and drew round ticks inside it, so the
 * labelled ticks ran (100) … (500) and stopped, and the last bar carried on
 * past the final labelled gridline: an axis that does not contain its own
 * data, as far as a reader can see. Where the extreme WAS the boundary —
 * Brightsphere's revenue of (5 535) — ECharts printed it as a tick, so the
 * axis read (1 000), (2 000) … (5 000), (5 535): four round numbers and one
 * observation, which invites the reader to take the extreme for a scale
 * mark.
 *
 * Rounding out fixes both, and costs the thing the label-inside-the-plot rule
 * in `packChartOptions` was protecting: a bar no longer reaches the top of
 * the domain, so its height is a slightly smaller fraction of the plot than
 * before. That was never the reading a bar carries — a reader compares bars
 * with one another and with the gridlines, and the gridlines are now round
 * numbers they can do arithmetic against.
 *
 * Zero is always in the domain: every chart here draws magnitudes from a
 * zero baseline, and an axis starting elsewhere would exaggerate every bar.
 *
 * @param intervals How many gridline steps the plot has ROOM for. The pack
 *   draws bridges at 48mm and at 110mm, and a tick count that suits the tall
 *   one overprints on the short one: the cash bridge printed
 *   `(100) (200) (300) (400) (500)` with 13.3px between 12pt labels. The
 *   caller knows its own box; this turns that into a step.
 */
export function axisDomain(values: number[], intervals = 6): AxisDomain {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = high - low;
  if (span === 0) return { min: 0, max: 0, splitNumber: 1 };
  const step = niceStep(span, intervals);
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  // Stated rather than left to ECharts' default of five, so the gridlines
  // land on the step the bounds were rounded to. Without it a domain of
  // (600) to nil is cut into five and the axis prints (120), (240), (360) —
  // round bounds carrying unround gridlines.
  return { min, max, splitNumber: Math.round((max - min) / step) };
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
  domain?: AxisDomain,
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
