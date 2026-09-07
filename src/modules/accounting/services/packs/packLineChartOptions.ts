/**
 * The pack's two LINE chart options: the page-3 tile sparkline and the
 * page-10 small-multiple panel.
 *
 * A sibling file rather than more of `packChartOptions.ts` only because that
 * file is at the repo's 300-line ceiling; the palette and its default come
 * from there, so there is still one chart theme.
 *
 * Both were previously drawn by `trendOption`, which is a BAR chart with a
 * full axis frame — so page 3's "inline sparkline, no axes" printed axes, and
 * page 10's small multiples were bars on independent y-scales while their own
 * `PackChartSpec.kind` said 'line'. Spec §4.A page 3 and page 10 are explicit
 * about both, and the only chart assertion in the suite was `svg.length > 0`,
 * which is why neither showed up.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { DEFAULT_CHART_PALETTE, type ChartPalette, type TrendPoint } from './packChartOptions';

/** The one ECharts label-callback field these formatters read. */
interface LabelParam {
  value?: unknown;
}

/**
 * A tile sparkline: the shape of the series and nothing else. No axes, no
 * grid, no labels — at 60mm × 48mm beside a big number, an axis frame is
 * noise a reader cannot read anyway.
 */
export function sparklineOption(
  points: TrendPoint[],
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 2, right: 2, top: 4, bottom: 4 },
    xAxis: { type: 'category', data: points.map((p) => p.label), show: false },
    yAxis: { type: 'value', show: false, scale: true },
    series: [
      {
        name: 'Actual',
        type: 'line',
        showSymbol: false,
        smooth: false,
        lineStyle: { color: palette.ink, width: 1.5 },
        itemStyle: { color: palette.ink },
        data: points.map((p) => p.value),
      },
    ],
  };
}

/**
 * One panel of page 10's small multiples.
 *
 * `domain` is passed in rather than computed per panel: spec §4.A page 10
 * requires a SHARED y-scale within a row, and a panel that scaled to its own
 * series would draw a flat metric and a collapsing one with identical-looking
 * slopes — direction read off a chart that has silently rescaled under the
 * reader is the failure the shared scale exists to stop.
 *
 * No legend (one series per panel, and the panel's title names it), and the
 * last point is labelled directly, so the reader never has to match a colour
 * to a key.
 *
 * @param formatValue How this panel's own unit prints. REQUIRED: a rand
 *   series, a percentage and a day count are three different units, and a
 *   panel row carries all three.
 * @param axis The scale the value axis prints.
 *
 *   `{ unit }` is the FULL-WIDTH treatment: a tick at every gridline in the
 *   panel's own unit, that unit named beside them, and a rule at zero. It is
 *   right for the 170mm cash line on page 8, which was otherwise six
 *   gridlines with no number anywhere on them — a director could not tell
 *   whether the trough was (600) or (6 000), or which side of zero the line
 *   sat on.
 *
 *   `{ endpoints: true }` labels the two ENDS of the domain and nothing
 *   between them, and draws a gridline at each. That is the page-10 panel:
 *   it was bare, on the reasoning that an 83mm panel read for direction beside
 *   five others does not need a scale — and then two of its titles started
 *   claiming a percentage OF that scale, and a reader had no way to check
 *   either claim, or to see that two of the six panels were not on the shared
 *   domain at all. Two labels is what a claim about a range costs; a full
 *   ladder of ticks in an 83mm panel is a grey smear. It also settles the
 *   gridline count, which ran 5, 8, 5 and 7 across four panels of one row
 *   with no values attached — rules that were decoration.
 *
 *   Omitted, the axis is bare.
 */
export function smallMultipleOption(
  points: TrendPoint[],
  domain: { min: number; max: number },
  formatValue: (value: number) => string,
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
  axis?: { unit: string } | { endpoints: true },
): EChartsCoreOption {
  const last = points[points.length - 1]?.value ?? 0;
  const unit = axis !== undefined && 'unit' in axis ? axis.unit : null;
  const endpoints = axis !== undefined && 'endpoints' in axis;
  return {
    animation: false,
    // ONE CHART LAYER, NOT THREE. The full-width line — page 8's closing
    // cash — sits between a waterfall and a composition bar chart, and it
    // was drawn on its own geometry: a 4px left gutter against their 80, a
    // 12px top against their 32, and axis type two points smaller than
    // either. On the printed sheet the plots started in three different
    // places down the left edge and the cash axis read as a footnote to the
    // other two. It takes the same grid as `waterfallOption` and
    // `compositionBarOption` now, with the right gutter it needs of its own
    // for the end label. The 83mm PANEL keeps its tight one: six of them to
    // a landscape sheet is a different form, and `containLabel` is what lets
    // a panel spend its width on the line.
    grid: unit === null
      ? { left: 4, right: 64, top: 12, bottom: 28, containLabel: true }
      : { left: 80, right: 64, top: 32, bottom: 64 },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      // First and last tick only: thirteen rotated month labels in an 82mm
      // panel is a grey smear, and the panel's job is direction, not level.
      axisLabel: { color: palette.axis, interval: Math.max(points.length - 2, 0), showMaxLabel: true },
      axisLine: { lineStyle: { color: palette.axis } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      // THE FULL-WIDTH LINE LETS THE AXIS ROUND ITS OWN ENDS.
      //
      // Forcing the domain onto it puts the series' extreme on the axis as a
      // label of its own, beside the last round tick it very nearly equals:
      // page 8 printed `(1 500)` and `(1 621)` two millimetres apart at the
      // foot of the scale, which is the same defect the reviewer found on
      // Brightsphere's cash axis. The domain is this series' own either way —
      // `sharedDomain` is called on one series here — and an ECharts value
      // axis contains zero by default, so nothing about what the picture
      // shows changes; only where the ticks fall. A PANEL keeps the forced
      // domain, because there the whole point is that four panels share one.
      ...(unit === null ? { min: domain.min, max: domain.max } : {}),
      // ONE INTERVAL, so the only ticks are the two ends of the domain. A
      // degenerate domain would give ECharts an interval of zero and an
      // infinite tick loop, so it keeps the default there.
      ...(endpoints && domain.max > domain.min ? { interval: domain.max - domain.min } : {}),
      ...(unit === null ? {} : {
        // The unit is NAMED on the axis rather than left to the caption: the
        // figures are in thousands and the only other place that is said on
        // this page is the table's own caption, a chart away.
        name: unit,
        nameLocation: 'end',
        nameGap: 8,
        nameTextStyle: { color: palette.axis, fontSize: 12, align: 'left' },
      }),
      axisLabel: axis === undefined
        ? { show: false }
        // 8pt in an 83mm panel, which has to carry a five-character figure
        // like `(1 621)` and still leave the plot something to draw in; 12
        // on the 170mm line, which is what the waterfall and the composition
        // chart on the sheets either side of it use, and what makes the
        // three read as one chart layer rather than three.
        : { show: true, color: palette.axis, fontSize: endpoints ? 8 : 12, formatter: (value: number) => formatValue(value) },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: palette.prior } },
    },
    series: [
      {
        name: 'Actual',
        type: 'line',
        showSymbol: false,
        lineStyle: { color: palette.ink, width: 2 },
        itemStyle: { color: palette.ink },
        endLabel: {
          show: true,
          color: palette.ink,
          // The end value, formatted the way the PANEL's own unit is
          // formatted. It was hard-wired to `formatMoney` with no scale, so
          // the gross-margin panel labelled −1394.3% as `(1 394)` and every
          // money panel printed raw rands under an `R'000` header. A panel
          // knows its unit and its scale; this function does not, so it is
          // handed one rather than guessing.
          formatter: (param: LabelParam) => formatValue(Number(param.value ?? last)),
        },
        data: points.map((p) => p.value),
        // A RULE AT ZERO, on the axis that has labels to read it against.
        // `sharedDomain` always puts zero inside the domain, but a gridline
        // is a gridline: on a series that is negative throughout, which is
        // every month of the live demo company's cash, nothing on the picture
        // said where break-even was.
        // ON THE FULL-WIDTH LINE ONLY. An endpoint axis already labels zero
        // wherever zero is an end of the domain — which `sharedDomain` and
        // `domainOf` make it on every series that does not cross it — and a
        // second rule inside an 83mm panel is one more thing drawn over a
        // line the panel exists to show.
        ...(unit === null ? {} : {
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: false },
            lineStyle: { color: palette.axis, width: 1, type: 'solid' },
            data: [{ yAxis: 0 }],
          },
        }),
      },
    ],
  };
}

/** The shared y-domain for a ROW of panels — the widest series decides it,
 *  and zero is always inside it so a reader can see which side of break-even
 *  a panel sits on. */
export function sharedDomain(series: number[][]): { min: number; max: number } {
  const values = series.flat();
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
}
