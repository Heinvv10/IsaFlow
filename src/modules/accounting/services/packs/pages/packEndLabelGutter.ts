/**
 * PAGE 8'S CLOSING FIGURE GOES IN A GUTTER OF ITS OWN, RIGHT OF THE PLOT.
 *
 * Five rounds placed it inside the plot — above the last point, below it,
 * then by drawing the chart again and again until a spot was free — and each
 * placement met the line, an axis label or the edge of the plot on some
 * series. A gutter to the right of the plot holds nothing else: the line
 * ends at the plot's edge and the month names sit under the plot. So the
 * grid reserves exactly the closing figure's measured width, the label is
 * drawn a fixed gap right of the last point, centred on it vertically, and
 * moved only as far as it takes to stay within the plot's height. One render.
 */
import { format } from 'echarts/core';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';

/** From the last point to the label's ground. */
export const END_LABEL_GAP_PX = 6;
const PAD_PX = 2;
const FONT_PX = 12;
const LINE_PX = FONT_PX + 2;

/** The right-hand gutter that holds `text`: the gap, its ground, a pixel spare. */
export function endLabelGutterPx(text: string): number {
  const width = format.getTextRect(text, `${FONT_PX}px ${PACK_FONT_STACK}`).width;
  return Math.ceil(END_LABEL_GAP_PX + width + PAD_PX * 2 + 1);
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
      align: 'left' as const,
      verticalAlign: 'middle' as const,
      distance: END_LABEL_GAP_PX,
      backgroundColor: paper,
      padding: [1, PAD_PX, 1, PAD_PX],
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
