/**
 * THE PLOT A BRIDGE'S AXIS IS CHOSEN FOR IS THE PLOT ECHARTS DRAWS.
 *
 * The domain, the tick count and every outside figure's position are worked
 * out against a plot height. That height was predicted as the box less a
 * fixed chrome, and ECharts shrank the grid whenever a rotated category name
 * needed more room — so on the demo's page 6 a figure placed for 148px was
 * clipped by a 123.9px plot. Read off the rendered SVG: the clip rectangle's
 * height equals the layout's, on page 6 and page 8 of every fixture.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { WATERFALL_CHROME, categoryDepthPx } from '@/modules/accounting/services/packs/packWaterfallDomain';
import { CHART_HEIGHT_MM, PX_PER_MM } from '@/lib/charts/ssrSvg';
import type { PackChartSpec } from '@/modules/accounting/services/packs/pages/packPageModel';
import * as A from './fixtures/boardPackInputs';
import * as B from './fixtures/liveDemoBoardPack';
import { clipRect } from './support/bridgeSvg';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';

/** A demo pack whose profit bridge carries the long plug name. */
const longName: BoardPackInput = {
  ...B.liveDemoInput,
  set: { ...B.liveDemoSet, current: { ...B.liveDemoSet.current, netProfit: B.liveDemoSet.current.netProfit - 25_000 } },
};

const INPUTS: Array<[string, BoardPackInput]> = [
  ...Object.entries({ ...A, ...B })
    .filter(([name, value]) => name.endsWith('Input') && typeof value === 'object')
    .map(([name, value]) => [name, value as BoardPackInput] as [string, BoardPackInput]),
  ['the demo with a long category name', longName],
];

function bridgesOf(input: BoardPackInput): PackChartSpec[] | null {
  let doc;
  try {
    doc = buildBoardPackPages(input);
  } catch (error) {
    // A fixture built to be refused — out of balance, a commentary too long
    // for its sheet. Anything else is a defect and fails the test.
    if (error instanceof PackRefusal) return null;
    throw error;
  }
  return doc.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === 'chart' && b.chart.kind === 'waterfall' ? [b.chart] : [])));
}

describe('every bridge draws the plot its layout was given', () => {
  let checked = 0;
  let longChecked = 0;
  it.each(INPUTS)('%s', (_name, input) => {
    const charts = bridgesOf(input);
    if (charts === null) return;
    for (const chart of charts) {
      // The tighter chrome is every box under the half rung — a bridge grown
      // a few millimetres past the bottom rung keeps it.
      const compact = chart.heightMm < CHART_HEIGHT_MM.half;
      const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
      const names = (chart.waterfallBars ?? []).map((b) => b.label);
      const bottom = Math.max(chrome.bottom, categoryDepthPx(names, chrome.labelPx));
      const boxPx = Math.round(chart.plotMm! * PX_PER_MM);
      const clip = clipRect(String(chart.svg));
      expect(clip.top, `${chart.id}: plot top`).toBe(chrome.top);
      expect(clip.height, `${chart.id}: plot height`).toBeCloseTo(boxPx - chrome.top - bottom, 6);
      checked += 1;
      if (bottom > chrome.bottom) longChecked += 1;
    }
  });

  it('is not vacuous — bridges were read, and one of them has a name long enough to move the plot', () => {
    expect(checked).toBeGreaterThan(20);
    expect(longChecked).toBeGreaterThan(0);
  });
});
