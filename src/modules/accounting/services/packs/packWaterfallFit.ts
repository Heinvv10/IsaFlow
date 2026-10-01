/**
 * WHETHER A BRIDGE FIGURE FITS INSIDE ITS BAR — ONE ANSWER, ASKED TWICE.
 *
 * A figure is in one of two states: wholly inside its bar, in the ink that
 * reads on the fill, or wholly outside it on its own side in ordinary ink.
 * The layout asks this function which, so it can give every figure that will
 * be set outside the room it needs; the renderer asks it again when it draws.
 * They may not disagree — a figure the renderer turned out of a bar the
 * layout thought held it has nowhere to go but back onto the bar, half on
 * and half off, which printed "226 871" with the lower half of every digit
 * white on white.
 *
 * Both dimensions, padded: the bar must be as tall as a line of type with
 * its padding and as wide as the figure with its own, the figure measured by
 * the face's real advances (`packFigureWidthPx`) — the width the browser
 * draws it at, so a figure is not turned out of a bar that holds it.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { packFigureWidthPx } from '@/lib/charts/packFigureWidth';

export const LABEL_GAP_PX = 4;
export const LABEL_LINE_PX = 12;

/** What a figure set outside its bar needs from the plot: its line and its gap. */
export const LABEL_CLEARANCE_PX = LABEL_GAP_PX + LABEL_LINE_PX;
/** The shortest bar that holds its own figure: a line of type, padded. */
export const LABEL_INSIDE_PX = LABEL_LINE_PX + LABEL_GAP_PX * 2;
/** The share of its category band a bar is drawn across. */
export const BAR_SHARE_OF_BAND = 0.6;

/**
 * THE TABLE'S SIGN, NOT THE STEP'S EFFECT ON PROFIT — see
 * `WaterfallStep.labelValue`. The bar's direction already carries the
 * effect; printing the negation of the figure in the table on the same sheet
 * made the chart look like it disagreed with it.
 */
export function figureText(step: WaterfallStep, scale: MoneyScale): string {
  return formatMoney(step.labelValue ?? step.value, { scale });
}

/** The paper kept either side of a figure: inside its bar, and at the
 *  plot's edge. */
const FIGURE_SIDE_PAD_PX = 1;

/** How wide a figure is drawn, with its side padding. */
export function figureWidthPx(text: string): number {
  return packFigureWidthPx(text, LABEL_LINE_PX) + FIGURE_SIDE_PAD_PX * 2;
}

/**
 * @param barWidthPx `undefined` where the caller cannot know it — a chart
 *   drawn at whatever width its container has. Nothing is taken to fit a bar
 *   of unknown width, so the layout gives every figure room outside.
 */
export function figureFitsInside(text: string, barHeightPx: number, barWidthPx: number | undefined): boolean {
  return barWidthPx !== undefined && barHeightPx >= LABEL_INSIDE_PX && figureWidthPx(text) <= barWidthPx;
}
