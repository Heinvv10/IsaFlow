/**
 * A BRIDGE'S WHOLE FRAME, WHERE THE CHART'S WIDTH IS KNOWN: the layout
 * (`waterfallLayout`) and the left gutter that holds what the axes print.
 *
 * With nothing allowed to shrink the plot (`outerBoundsMode: 'none'`), the
 * shared 80px gutter is a guess: a tick in whole rands past a hundred million
 * is wider than it, and so is a long first category name on its 30° slant —
 * both ran off the chart's left edge. So the gutter is sized from the ticks
 * the axis will print and the names under the first bars, in the face they
 * are drawn in. The two depend on each other — a wider gutter is a narrower
 * plot, narrower bars, perhaps a figure turned out of its bar and a taller
 * axis with different ticks — so they are iterated to a fixed point. Bounded;
 * it settles in two passes on every bridge the pack draws.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { packFigureWidthPx } from '@/lib/charts/packFigureWidth';
import { axisDomain } from './packChartAxes';
import { CHART_GUTTER_PX, CHART_GUTTER_RIGHT_PX } from './packChartGutters';
import { figureText, LABEL_LINE_PX } from './packWaterfallFit';
import {
  CATEGORY_ROTATE_DEG, packTextMeasure, WATERFALL_CHROME, waterfallLayout, type TextMeasure, type WaterfallLayout,
} from './packWaterfallDomain';

/** ECharts' gap between an axis and its labels, and a pixel or two of slack
 *  for a browser that sets the face a little wider than the measure. */
const AXIS_LABEL_MARGIN_PX = 8;
const SLACK_PX = 2;
/** However wide the ticks, the plot keeps this share of the chart. */
const MAX_GUTTER_SHARE = 0.5;
const MAX_PASSES = 4;

export interface WaterfallFrame extends WaterfallLayout { left: number }

export function waterfallFrame(
  steps: WaterfallStep[],
  box: { heightPx: number; widthPx: number },
  compact: boolean,
  askHint: number | undefined,
  measure: TextMeasure,
  texts: readonly string[],
  /** How wide the value axis prints a tick at `value`, in its own face. */
  tickWidthPx: (value: number) => number,
  /** What it prints there. */
  tickText: (value: number) => string,
): WaterfallFrame {
  const labelPx = (compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full).labelPx;
  const rad = (CATEGORY_ROTATE_DEG * Math.PI) / 180;
  const names = steps.map((s) => measure(s.label, labelPx));
  let left = CHART_GUTTER_PX;
  const fitAt = (gutter: number) => ({ texts, tickText, plotLeftPx: gutter, plotWidthPx: box.widthPx - gutter - CHART_GUTTER_RIGHT_PX });
  let layout = waterfallLayout(steps, box.heightPx, compact, askHint, measure, fitAt(left));
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const { min, max, splitNumber, interval } = layout.domain;
    const stepSize = interval ?? (max - min) / Math.max(1, splitNumber);
    const ticks = stepSize > 0 ? Array.from({ length: Math.round((max - min) / stepSize) + 1 }, (_, i) => min + i * stepSize) : [min];
    const band = (box.widthPx - left - CHART_GUTTER_RIGHT_PX) / Math.max(1, steps.length);
    // A name is set right-aligned under its band's centre and slants down to
    // the left: how far left of the plot's edge its far end reaches.
    const nameNeed = Math.max(0, ...names.map((n, i) => n.width * Math.cos(rad) + (n.height * Math.sin(rad)) / 2 - band * (i + 0.5)));
    const tickNeed = Math.max(...ticks.map(tickWidthPx)) + AXIS_LABEL_MARGIN_PX;
    const need = Math.min(Math.ceil(Math.max(tickNeed, nameNeed) + SLACK_PX), Math.floor(box.widthPx * MAX_GUTTER_SHARE));
    if (need <= left) break;
    left = need;
    layout = waterfallLayout(steps, box.heightPx, compact, askHint, measure, fitAt(left));
  }
  return { ...layout, left };
}

/** The size a value axis sets its ticks at. */
const TICK_PX = 12;

/** A bridge's frame: its margins, its value axis, its figures' size. */
export function frameOf(
  steps: WaterfallStep[], scale: MoneyScale, intervals: number, compact: boolean,
  box: number | { heightPx: number; widthPx: number } | undefined, measure: TextMeasure,
) {
  const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
  const texts = steps.map((s) => figureText(s, scale));
  // Ticks are figures: in the print face, the face's own advances.
  const tickText = (value: number) => formatMoney(value, { scale });
  const tickWidthPx = (value: number) => {
    const text = tickText(value);
    return measure === packTextMeasure ? packFigureWidthPx(text, TICK_PX) : measure(text, TICK_PX).width;
  };
  if (box === undefined) {
    return { top: chrome.top, bottom: chrome.bottom, domain: axisDomain(steps.flatMap((s) => [s.start, s.end]), intervals), fontPx: LABEL_LINE_PX, left: CHART_GUTTER_PX };
  }
  return typeof box === 'object'
    ? waterfallFrame(steps, box, compact, intervals, measure, texts, tickWidthPx, tickText)
    : { ...waterfallLayout(steps, box, compact, intervals, measure, { texts, tickText }), left: CHART_GUTTER_PX };
}

/**
 * How large a bridge is DRAWN in a box: its plot's height and its tallest
 * bar's, in pixels. For a caller choosing between two boxes — a taller box
 * is not a bigger picture if its margins took the difference.
 */
export function waterfallDrawnSize(
  steps: WaterfallStep[], scale: MoneyScale, intervals: number, compact: boolean, box: { heightPx: number; widthPx: number },
): { plotPx: number; tallestBarPx: number } {
  const { domain, top, bottom } = frameOf(steps, scale, intervals, compact, box, packTextMeasure);
  const plotPx = box.heightPx - top - bottom;
  const span = domain.max - domain.min;
  return { plotPx, tallestBarPx: span > 0 ? (Math.max(0, ...steps.map((s) => Math.abs(s.end - s.start))) / span) * plotPx : 0 };
}
