/**
 * NOTHING A CHART PAINTS LIES OUTSIDE ITS OWN SVG.
 *
 * On every bridge of 48mm or less the axis name — `R'000` — was centred a
 * pixel ABOVE the top of the SVG: the compact rung gives the plot 20px of
 * head, and ECharts sets an axis name 15px clear of the axis. The top half of
 * the unit the whole chart is stated in was cut off on paper. Nothing looked
 * for it because every check read the plot, not the chart's own edges.
 *
 * So, for every chart of every fixture pack: each text's box and each
 * rectangle lies inside the SVG it is drawn in.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import * as boardPackInputs from './fixtures/boardPackInputs';
import { outsideSvg as outside } from './support/svgBounds';
import * as liveDemo from './fixtures/liveDemoBoardPack';

const isInput = (v: unknown): v is BoardPackInput => typeof v === 'object' && v !== null && 'set' in v && 'trend' in v && 'brand' in v;
const INPUTS = Object.entries({ ...boardPackInputs, ...liveDemo }).filter((e): e is [string, BoardPackInput] => isInput(e[1]));

/** Every chart SVG a pack carries, wherever a block keeps one. */
function chartSvgs(value: unknown, out: Array<{ id: string; svg: string }> = []): Array<{ id: string; svg: string }> {
  if (Array.isArray(value)) { for (const v of value) chartSvgs(v, out); return out; }
  if (typeof value !== 'object' || value === null) return out;
  const o = value as Record<string, unknown>;
  if (typeof o.svg === 'string' && o.svg.startsWith('<svg')) out.push({ id: String(o.id ?? o.title ?? 'chart'), svg: o.svg });
  for (const v of Object.values(o)) chartSvgs(v, out);
  return out;
}

describe('no chart paints outside its own SVG', () => {
  it('reads a known pack\'s charts, texts and all', () => {
    expect(INPUTS.length).toBeGreaterThan(10);
    const charts = chartSvgs(buildBoardPackPages(liveDemo.liveDemoRenderedInput).pages);
    expect(charts.length).toBeGreaterThan(5);
    expect(charts.some((c) => /<text[^>]*>R&#39;000<\/text>/.test(c.svg)), 'no chart names its unit, so the axis name is not under test').toBe(true);
  });

  it.each(INPUTS)('%s', (_name, input) => {
    let pages: unknown;
    // A fixture built to be refused composes no charts to check.
    try { pages = buildBoardPackPages(input).pages; } catch { return; }
    const found = chartSvgs(pages).flatMap((c) => outside(c.svg).map((s) => `${c.id}: ${s}`));
    expect(found).toEqual([]);
  });
});
