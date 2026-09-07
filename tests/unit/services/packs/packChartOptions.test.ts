import { describe, it, expect } from 'vitest';
import { waterfallOption, trendOption, stepPaint, DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { FALLBACK } from '@/lib/charts/theme';
import { formatMoney } from '@/lib/format/money';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type {
  CustomSeriesRenderItem,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
} from 'echarts';

const steps: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 1000, value: 1000, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: 1000, end: 600, value: -400, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: 600, value: 600, isSubtotal: true, color: 'teal' },
];

interface CustomSeries { type: string; renderItem: CustomSeriesRenderItem; data: Array<[number, number]> }
interface TooltipFormatterOption {
  tooltip: { formatter: (params: { dataIndex: number } | Array<{ dataIndex: number }>) => string };
}

/** A pixel mapping simple enough to reason about by hand: y = ZERO_Y - value *
 *  SCALE, so a positive value sits above the zero line (smaller y, as SVG y
 *  grows downward) and a negative value sits below it. Matches how ECharts'
 *  real coordinate system behaves for a value axis without asserting any of
 *  ECharts' own internals. */
const ZERO_Y = 500;
const SCALE = 0.001;

function fakeApi(): CustomSeriesRenderItemAPI {
  return {
    coord: (data: number[]) => [Number(data[0]) * 40, ZERO_Y - Number(data[1]) * SCALE],
    size: () => [30, 0],
  } as unknown as CustomSeriesRenderItemAPI;
}

function renderRect(series: CustomSeries, dataIndex: number): { x: number; y: number; width: number; height: number } {
  const params = { dataIndex } as unknown as CustomSeriesRenderItemParams;
  const result = series.renderItem(params, fakeApi()) as CustomSeriesRenderItemReturn & {
    children?: Array<{ type: string; shape?: { x: number; y: number; width: number; height: number }; style?: { fill: string } }>;
  };
  const rect = result.children?.find((c) => c.type === 'rect');
  if (!rect?.shape) throw new Error('renderItem did not return a rect child');
  return rect.shape;
}

function rectColour(series: CustomSeries, dataIndex: number): string {
  const params = { dataIndex } as unknown as CustomSeriesRenderItemParams;
  const result = series.renderItem(params, fakeApi()) as CustomSeriesRenderItemReturn & {
    children?: Array<{ type: string; style?: { fill: string } }>;
  };
  const rect = result.children?.find((c) => c.type === 'rect');
  return rect?.style?.fill ?? '';
}

describe('waterfallOption', () => {
  it('labels the x axis with the step labels, in order', () => {
    const opt = waterfallOption(steps) as { xAxis: { data: string[] } };
    expect(opt.xAxis.data).toEqual(['Revenue', 'Cost of Sales', 'Gross Profit']);
  });

  it('is a single custom series carrying [start, end] geometry, not a stacked pair', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    expect(opt.series).toHaveLength(1);
    expect(opt.series[0]!.type).toBe('custom');
    expect(opt.series[0]!.data).toEqual([[0, 1000], [1000, 600], [0, 600]]);
  });

  it('draws each bar spanning exactly its own start-to-end pixel range', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;
    // Revenue: 0 -> 1000, entirely above the zero line.
    const revenue = renderRect(series, 0);
    expect(revenue.y).toBeCloseTo(ZERO_Y - 1000 * SCALE);
    expect(revenue.height).toBeCloseTo(1000 * SCALE);
  });

  it('paints increases favourable, decreases unfavourable, subtotals in ink', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;
    expect(rectColour(series, 0)).toBe(DEFAULT_CHART_PALETTE.fav);
    expect(rectColour(series, 1)).toBe(DEFAULT_CHART_PALETTE.unfav);
    expect(rectColour(series, 2)).toBe(DEFAULT_CHART_PALETTE.ink);
  });

  /**
   * THE BAR MODEL AND THE DRAWING CANNOT DISAGREE ABOUT THE INK.
   *
   * Page 6's footnote now tells a director which colour a named bar is drawn
   * in and why — a claim about the picture, made in words beside it. It reads
   * `PackWaterfallBar.paint`, which is `stepPaint`; this holds `stepPaint` to
   * the colour the same step is actually painted, so the two cannot drift
   * into a sheet that describes a bar it did not draw.
   */
  it('reports the same class it paints, step by step', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;
    steps.forEach((step, index) => {
      const expected = stepPaint(step) === null
        ? DEFAULT_CHART_PALETTE.ink
        : stepPaint(step) === 'favourable'
          ? DEFAULT_CHART_PALETTE.fav
          : DEFAULT_CHART_PALETTE.unfav;
      expect(rectColour(series, index), `${step.label} is not painted as it is reported`)
        .toBe(expected);
    });
    // And a cost line keeps its class when the period runs the other way: a
    // net-credit expense band is still drawn as a cost, which is the whole
    // reason the footnote has to say so.
    expect(stepPaint({
      label: 'Operating Expenses', start: 0, end: 3_717_000, value: -3_717_000,
      isSubtotal: false, color: 'red',
    })).toBe('unfavourable');
  });

  it('draws a bar that spans both sides of zero when the running total crosses it', () => {
    // Gross Profit 400,000 -> Opex takes it to a loss of 400,000 -> Net
    // Profit subtotal sits at -400,000. The old transparent-base-plus-stack
    // trick drew this entirely above the axis; it must now cross it.
    const crossing: WaterfallStep[] = [
      { label: 'Gross Profit', start: 0, end: 400_000, value: 400_000, isSubtotal: true, color: 'teal' },
      { label: 'Operating Expenses', start: 400_000, end: -400_000, value: -800_000, isSubtotal: false, color: 'red' },
      { label: 'Net Profit', start: 0, end: -400_000, value: -400_000, isSubtotal: true, color: 'blue' },
    ];
    const opt = waterfallOption(crossing) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;

    const movement = renderRect(series, 1);
    expect(movement.y).toBeLessThan(ZERO_Y);
    expect(movement.y + movement.height).toBeGreaterThan(ZERO_Y);

    // The negative subtotal sits below the zero line, not above it, and is
    // still ink — a subtotal has no variance colour of its own.
    const subtotal = renderRect(series, 2);
    expect(subtotal.y).toBeGreaterThanOrEqual(ZERO_Y);
    expect(rectColour(series, 2)).toBe(DEFAULT_CHART_PALETTE.ink);
  });

  it('prints the service figure on the bar label, never a derived height', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;
    const params = { dataIndex: 1 } as unknown as CustomSeriesRenderItemParams;
    const result = series.renderItem(params, fakeApi()) as CustomSeriesRenderItemReturn & {
      children?: Array<{ type: string; style?: { text?: string } }>;
    };
    const text = result.children?.find((c) => c.type === 'text');
    // Cost of Sales: value -400 — the signed service figure, not abs(400).
    expect(text?.style?.text).toContain('400');
    expect(text?.style?.text).toMatch(/[(−-]/); // parenthesised or minus-signed
  });

  /**
   * ADVERSARIAL LOW-5: the tooltip printed the raw number, so hovering a bar
   * to CHECK a figure showed a different rendering of it from the bar's own
   * label, the statement beside it and the deck.
   */
  it('formats the tooltip figure the way every other money figure is formatted', () => {
    const opt = waterfallOption(steps) as unknown as TooltipFormatterOption;
    expect(opt.tooltip.formatter({ dataIndex: 0 })).toBe(`Revenue: ${formatMoney(steps[0]!.value)}`);
    // Not the raw number: 1000 renders as "1 000", never "1000".
    expect(opt.tooltip.formatter({ dataIndex: 0 })).not.toBe(`Revenue: ${steps[0]!.value}`);
    // A negative comes back parenthesised, like the statement's own cells.
    expect(opt.tooltip.formatter({ dataIndex: 1 })).toContain('(');
  });

  it('escapes a hostile step label before it reaches the tooltip HTML', () => {
    const hostile: WaterfallStep[] = [
      { label: '<img src=x onerror=1>', start: 0, end: 100, value: 100, isSubtotal: false, color: 'green' },
    ];
    const opt = waterfallOption(hostile) as unknown as TooltipFormatterOption;
    const html = opt.tooltip.formatter({ dataIndex: 0 });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('trendOption', () => {
  const points = [
    { label: 'Mar 2026', value: 100 },
    { label: 'Apr 2026', value: 140 },
  ];

  it('plots the points as given, in order', () => {
    const opt = trendOption(points) as unknown as { xAxis: { data: string[] }; series: Array<{ data: number[] }> };
    expect(opt.xAxis.data).toEqual(['Mar 2026', 'Apr 2026']);
    expect(opt.series[0]!.data).toEqual([100, 140]);
  });

  it('renders without animation, so a headless screenshot is never mid-transition', () => {
    const opt = trendOption(points) as { animation: boolean };
    expect(opt.animation).toBe(false);
  });

  it('formats the tooltip figure through formatMoney too', () => {
    const opt = trendOption([{ label: 'Mar 2026', value: 1234567 }]) as unknown as TooltipFormatterOption;
    expect(opt.tooltip.formatter({ dataIndex: 0 })).toBe(`Mar 2026: ${formatMoney(1234567)}`);
  });

  it('escapes a hostile point label before it reaches the tooltip HTML', () => {
    const hostile = [{ label: '<img src=x onerror=1>', value: 5 }];
    const opt = trendOption(hostile) as unknown as TooltipFormatterOption;
    const html = opt.tooltip.formatter({ dataIndex: 0 });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

/**
 * ADVERSARIAL MEDIUM-4: this palette restated `src/lib/charts/theme.ts`'s
 * FALLBACK — five hex values, byte for byte, in two files. One edit to either
 * and the pack's charts and the app's charts are different colours with
 * nothing to say which is right. It is now imported.
 */
describe('DEFAULT_CHART_PALETTE', () => {
  it('is the app theme\'s own fallback palette, not a second copy of it', () => {
    expect(DEFAULT_CHART_PALETTE).toEqual({
      ink: FALLBACK.ink,
      fav: FALLBACK.fav,
      unfav: FALLBACK.unfav,
      prior: FALLBACK.prior,
      // The axis grey IS the theme's tertiary text colour — the same grey the
      // rest of the app uses for secondary labels.
      axis: FALLBACK.textTertiary,
      // The categorical ramp is NOT one of the theme's semantic five — it is
      // a scale, for a chart whose bands are categories rather than
      // directions. Asserted separately below.
      categorical: DEFAULT_CHART_PALETTE.categorical,
      // Not one of the theme's five either: the app's charts are drawn on
      // whatever surface the page gives them and never need to know. A
      // printed pack's surface is the sheet, and a bar label set INSIDE an
      // ink-filled total bar has to be set in it or it is invisible.
      paper: '#ffffff',
    });
  });

  /**
   * BOARD PACKS GET PHOTOCOPIED. Sheet 7 distinguished liabilities from
   * equity by the red/green pair alone — luminances of 83.5 and 99.4 out of
   * 255, a six per cent separation — so in black and white it became two
   * identical mid-grey blocks under a legend that could no longer be matched
   * to them. The categorical ramp carries the distinction in LIGHTNESS, which
   * is the one channel a photocopier keeps.
   */
  it('separates every categorical band in greyscale, not only in hue', () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const greys = DEFAULT_CHART_PALETTE.categorical.map(luminance);
    expect(greys.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < greys.length; i += 1) {
      expect(
        Math.abs(greys[i]! - greys[i - 1]!),
        `bands ${i - 1} and ${i} are ${greys[i - 1]!.toFixed(0)} and ${greys[i]!.toFixed(0)} `
          + 'out of 255 — the same grey on a photocopy',
      ).toBeGreaterThan(30);
    }
    // And the ramp is not the semantic pair under another name: neither the
    // favourable green nor the unfavourable red may appear in it.
    expect(DEFAULT_CHART_PALETTE.categorical).not.toContain(FALLBACK.fav);
    expect(DEFAULT_CHART_PALETTE.categorical).not.toContain(FALLBACK.unfav);
  });
});
