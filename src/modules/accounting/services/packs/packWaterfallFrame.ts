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
import { CHART_GUTTER_PX, CHART_GUTTER_RIGHT_PX } from './packChartGutters';
import {
  CATEGORY_ROTATE_DEG, WATERFALL_CHROME, waterfallLayout, type TextMeasure, type WaterfallLayout,
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
): WaterfallFrame {
  const labelPx = (compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full).labelPx;
  const rad = (CATEGORY_ROTATE_DEG * Math.PI) / 180;
  const names = steps.map((s) => measure(s.label, labelPx));
  let left = CHART_GUTTER_PX;
  let layout = waterfallLayout(steps, box.heightPx, compact, askHint, measure, { texts, plotLeftPx: left, plotWidthPx: box.widthPx - left - CHART_GUTTER_RIGHT_PX });
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
    layout = waterfallLayout(steps, box.heightPx, compact, askHint, measure, { texts, plotLeftPx: left, plotWidthPx: box.widthPx - left - CHART_GUTTER_RIGHT_PX });
  }
  return { ...layout, left };
}
