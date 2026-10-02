/**
 * PAGE 8'S CLOSING FIGURE GOES IN A GUTTER OF ITS OWN, RIGHT OF THE PLOT.
 *
 * Five rounds placed it inside the plot — above the last point, below it,
 * then by drawing the chart again and again until a spot was free — and each
 * placement met the line, an axis label or the edge of the plot on some
 * series. A gutter to the right of the plot holds nothing else: the line
 * ends at the plot's edge and the month names sit under the plot. So the
 * grid reserves the closing figure's width — as the face sets it, not as
 * zrender's table guesses it (`packFigureWidthPx`), which stood nine pixels
 * too wide for every thousands separator — the label is drawn a fixed gap
 * right of the last point, centred on it vertically, and moved only as far
 * as it takes to stay within the plot's height. One render.
 *
 * No rectangular ground under it — zrender would cut one to its own
 * over-wide measure, past the edge of the chart. Nothing else is drawn in the
 * gutter; for the one series that keeps its label on the plot (a single
 * point has no right-hand end) the glyphs carry a paper halo, as a bridge
 * figure outside its bar does, so no gridline runs through them.
 */
import { packFigureWidthPx } from '@/lib/charts/packFigureWidth';

/** From the last point to the label. */
export const END_LABEL_GAP_PX = 6;
const SPARE_PX = 2;
const FONT_PX = 12;
const LINE_PX = FONT_PX + 2;
const HALO_PX = 4;

/** The right-hand gutter that holds `text`: the gap, the figure, a little spare. */
export function endLabelGutterPx(text: string): number {
  return Math.ceil(END_LABEL_GAP_PX + packFigureWidthPx(text, FONT_PX) + SPARE_PX);
}

interface LabelLayoutParams { labelRect: { y: number; height: number } }

/**
 * The end label's style, and the series `labelLayout` that holds its box
 * inside the plot's height. `plotTop`/`plotBottom` are in the chart's pixels
 * — the grid's top, and the box less the grid's bottom.
 */
export function gutterEndLabel(paper: string, plotTop: number, plotBottom: number) {
  return {
    style: {
      textBorderColor: paper,
      textBorderWidth: HALO_PX,
      align: 'left' as const,
      verticalAlign: 'middle' as const,
      distance: END_LABEL_GAP_PX,
      lineHeight: LINE_PX,
    },
    labelLayout: (params: LabelLayoutParams) => {
      const { y, height } = params.labelRect;
      // A plot shorter than the label — the bottom rung under a long title —
      // cannot hold it either way: it is centred on the plot instead.
      if (height > plotBottom - plotTop) return { dy: (plotTop + plotBottom) / 2 - (y + height / 2) };
      if (y < plotTop) return { dy: plotTop - y };
      if (y + height > plotBottom) return { dy: plotBottom - (y + height) };
      return {};
    },
  };
}
