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
 */
export function smallMultipleOption(
  points: TrendPoint[],
  domain: { min: number; max: number },
  formatValue: (value: number) => string,
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
): EChartsCoreOption {
  const last = points[points.length - 1]?.value ?? 0;
  return {
    animation: false,
    grid: { left: 4, right: 64, top: 12, bottom: 28, containLabel: true },
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
      min: domain.min,
      max: domain.max,
      axisLabel: { show: false },
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
