/**
 * A BRIDGE'S PLOT RECTANGLE AND VALUE AXIS, CHOSEN TOGETHER AND EXACTLY.
 *
 * Three rounds placed a short bar's figure against a PREDICTED plot height and
 * each fix made the next defect. The prediction was wrong whenever a category
 * name was long: ECharts shrank the grid to keep the rotated name inside the
 * box (on the demo, a plot assumed 148px tall drew 123.9), and a figure the
 * domain had made room for was clipped out of the chart.
 *
 * So nothing here predicts:
 *   1. The grid's bottom margin is sized from the longest category name at
 *      its rotation, and the option turns ECharts' shrinking off
 *      (`outerBoundsMode: 'none'`), so the plot ECharts draws IS
 *      `boxPx - top - bottom`. Held by a test that reads the clip rect.
 *   2. The tick count and the label headroom are chosen JOINTLY: every
 *      figure is placed by the renderer's own function (`placeFigures`), the
 *      axis is extended to hold whichever run past the plot, the step
 *      count is held to the pitch budget, and the two are iterated to a
 *      fixed point where both hold. Bounded; the renderer checks the result
 *      against the real rectangle and has a fallback for the rare state that
 *      does not settle.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { format } from 'echarts/core';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { axisDomain, MIN_TICK_PITCH_PX, TICK_PITCH_PX, type AxisDomain } from './packChartAxes';
import { NIL_STEP_RULE_PX } from './packWaterfallBars';
import { BAR_SHARE_OF_BAND, FIGURE_SIZES_PX, LABEL_LINE_PX } from './packWaterfallFit';
import { placeFigures, type BarPx } from './packWaterfallPlace';

/**
 * The axis chrome, at the two rungs. `bottom` is the floor for the category
 * names; a name longer than it holds raises it (`categoryDepthPx`).
 *
 * The compact rung sets the names at 10px: "Operating Expenses" rotated
 * thirty degrees stands about 46px tall plus its line, inside 56.
 */
export const WATERFALL_CHROME = {
  full: { top: 32, bottom: 72, labelPx: 12 },
  compact: { top: 20, bottom: 56, labelPx: 10 },
} as const;

export { MIN_TICK_PITCH_PX, TICK_PITCH_PX };

/** The category names' rotation, and ECharts' gap between axis and name. */
export const CATEGORY_ROTATE_DEG = 30;
const AXIS_LABEL_MARGIN_PX = 8;
/** A browser measures with the face it has loaded, and may set a name a
 *  little wider than zrender's own table does on the server. */
const MEASURE_SLACK_PX = 2;

/** The box a line of text takes, in the face the chart draws it in. */
export type TextMeasure = (text: string, fontPx: number) => { width: number; height: number };

/** The pack's print face, measured by zrender — the measurer ECharts lays
 *  the print charts out with. */
export const packTextMeasure: TextMeasure = (text, fontPx) => format.getTextRect(text, `${fontPx}px ${PACK_FONT_STACK}`);

/** A monospaced face: every glyph the same advance. The management pack's
 *  screen theme sets chart text in IBM Plex Mono (`lib/charts/theme.ts`),
 *  whose advance is 0.6em. */
export function monospaceMeasure(em = 0.6): TextMeasure {
  return (text, fontPx) => ({ width: text.length * em * fontPx, height: fontPx });
}

/**
 * How far below the plot the rotated category names reach, measured in the
 * face the chart draws them in, so the margin and the drawing agree.
 */
export function categoryDepthPx(names: readonly string[], fontPx: number, measure: TextMeasure = packTextMeasure): number {
  const rad = (CATEGORY_ROTATE_DEG * Math.PI) / 180;
  const boxes = names.map((name) => measure(name, fontPx));
  const depth = Math.max(0, ...boxes.map((b) => b.width * Math.sin(rad) + b.height * Math.cos(rad)));
  return Math.ceil(AXIS_LABEL_MARGIN_PX + depth + MEASURE_SLACK_PX);
}

export interface WaterfallLayout {
  top: number;
  bottom: number;
  /** The plot's height — exactly the clip rect ECharts draws. */
  plotPx: number;
  domain: AxisDomain;
  /** The size every figure on the chart is set at — see `FIGURE_SIZES_PX`. */
  fontPx: number;
}

const MAX_PASSES = 16;
/** How many lines out a figure may be staggered before the type is set a
 *  size smaller instead. */
const MAX_STAGGER = 2;
/** Bars of unknown width are placed this far apart: no two figures meet. */
const FAR_APART_PX = 1e6;

/**
 * What the layout knows of the figures: the text each bar prints, and the
 * plot's horizontal extent where the chart's width is known. Without it no
 * bar's width is known, nothing is taken to fit inside, and every figure is
 * given room outside — see `figureFitsInside`.
 */
export interface FigureFit { texts: readonly string[]; plotLeftPx?: number; plotWidthPx?: number }

/** The bars in pixels, on a plot `plotPx` tall with its top at zero. */
function barsPx(steps: WaterfallStep[], domain: AxisDomain, plotPx: number, fit?: FigureFit): BarPx[] {
  const perUnit = plotPx / (domain.max - domain.min);
  const band = fit?.plotWidthPx === undefined ? undefined : fit.plotWidthPx / Math.max(1, steps.length);
  return steps.map((step, i) => {
    const height = Math.abs(step.end - step.start) * perUnit;
    return {
      centre: band === undefined ? i * FAR_APART_PX : (fit?.plotLeftPx ?? 0) + band * (i + 0.5),
      top: (domain.max - Math.max(step.start, step.end)) * perUnit,
      height,
      drawnHeight: Math.max(height, NIL_STEP_RULE_PX),
      width: band === undefined ? undefined : band * BAR_SHARE_OF_BAND,
      rises: step.end > step.start,
      falls: step.end < step.start,
      subtotal: step.isSubtotal,
      text: fit?.texts[i] ?? '',
    };
  });
}

/**
 * Where the figures run past the plot, as the user values the axis must
 * reach to hold them, and how far out the furthest was staggered.
 */
function overrun(steps: WaterfallStep[], domain: AxisDomain, plotPx: number, fit: FigureFit | undefined, fontPx: number) {
  if (!(domain.max > domain.min)) return { reach: [] as number[], level: 0 };
  const left = fit?.plotWidthPx === undefined ? -Infinity : fit.plotLeftPx ?? 0;
  const plot = { left, right: fit?.plotWidthPx === undefined ? Infinity : left + fit.plotWidthPx, top: 0, bottom: plotPx };
  const placed = placeFigures(barsPx(steps, domain, plotPx, fit), plot, fontPx, false);
  const valueAt = (px: number) => domain.max - (px / plotPx) * (domain.max - domain.min);
  // In pixels, so float residue at a domain of a trillion is not a reach.
  const slack = 1e-6;
  const reach = placed.flatMap((p) => {
    if (p.inside) return [];
    const far = p.below ? p.top + fontPx + NIL_STEP_RULE_PX : p.top - NIL_STEP_RULE_PX;
    return (p.below ? far > plotPx + slack : far < -slack) ? [valueAt(far)] : [];
  });
  return { reach, level: Math.max(0, ...placed.map((p) => p.level)) };
}

/** Whether every outside figure has room on its own side of its bar. */
export function labelsFit(steps: WaterfallStep[], domain: AxisDomain, plotPx: number, fit?: FigureFit, fontPx: number = LABEL_LINE_PX): boolean {
  return overrun(steps, domain, plotPx, fit, fontPx).reach.length === 0;
}

/**
 * @param askHint The step count the caller budgets for its plot. Absent, the
 *   plot's own budget at `TICK_PITCH_PX`.
 */
export function waterfallLayout(
  steps: WaterfallStep[],
  boxPx: number,
  compact: boolean,
  askHint?: number,
  measure: TextMeasure = packTextMeasure,
  fit?: FigureFit,
): WaterfallLayout {
  const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
  const bottom = Math.max(chrome.bottom, categoryDepthPx(steps.map((s) => s.label), chrome.labelPx, measure));
  const plotPx = boxPx - chrome.top - bottom;
  // THE ASK IS THE CALLER'S, AND THE BUDGET IS LEGIBILITY. Rounding the step
  // and widening for headroom can each draw more steps than were asked for —
  // asked four, the cash bridge drew six at 17.6px — so whatever is asked,
  // no domain is accepted that puts two ticks closer than
  // `MIN_TICK_PITCH_PX`; the ask is lowered until none does.
  const budget = Math.max(1, Math.floor(plotPx / MIN_TICK_PITCH_PX));
  const ends = steps.flatMap((step) => [step.start, step.end]);

  const settle = (fontPx: number) => {
    let ask = Math.min(askHint ?? Math.max(2, Math.floor(plotPx / TICK_PITCH_PX)), budget);
    let reach: number[] = [];
    let domain = axisDomain(ends, ask);
    let settled = false;
    let level = 0;
    for (let pass = 0; pass < MAX_PASSES && !settled; pass += 1) {
      domain = axisDomain([...ends, ...reach], ask);
      if (domain.splitNumber > budget && ask > 1) {
        // Rounding the step and the bounds drew more steps than the plot holds:
        // ask for one fewer and start the headroom again on the coarser axis.
        ask -= 1;
        reach = [];
        continue;
      }
      const over = overrun(steps, domain, plotPx, fit, fontPx);
      level = over.level;
      settled = over.reach.length === 0;
      reach = [...reach, ...over.reach];
    }
    return { domain, fontPx, clear: settled && level <= MAX_STAGGER };
  };
  // THE TYPE IS SET A SIZE SMALLER ONLY WHERE THE FIGURES CANNOT BE KEPT
  // APART AT TWELVE — a bridge of nine-digit figures on narrow bars, where
  // clearing them would stagger one more than two lines out, or the axis
  // will not settle. Every figure on the chart takes the one size. Only
  // where the bars' widths are known: without them no two figures meet.
  const sizes = fit?.plotWidthPx === undefined ? [LABEL_LINE_PX] : FIGURE_SIZES_PX;
  let chosen = settle(sizes[0]!);
  for (const size of sizes.slice(1)) if (!chosen.clear) chosen = settle(size);
  let domain = chosen.domain;
  // A PLOT TOO SHORT FOR TWO LEGIBLE STEPS draws one. The ask cannot go
  // below one, and the rounding can still return two or three; the bounds
  // stay, and the axis labels its two ends only.
  if (domain.splitNumber > budget) domain = { ...domain, splitNumber: budget, interval: domain.max - domain.min };
  return { top: chrome.top, bottom, plotPx, domain, fontPx: chosen.fontPx };
}
