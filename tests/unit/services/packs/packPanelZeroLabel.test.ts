/**
 * A PANEL'S ZERO LINE CARRIES ITS FIGURE.
 *
 * Page 10's gross margin, net profit and cash panels drew the darker rule at
 * zero between two end labels, and nothing named it: a reader had the ends of
 * the scale and a line with no value, on the panels whose whole question is
 * which side of break-even they sit. The rule is labelled now, in the panel's
 * own unit, wherever it stands clear of both end labels.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput, liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the demo company', demoInput],
  ['the live demo company, long window', liveDemoInput],
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['the live demo company, short panels', liveDemoShortPanelsInput],
  ['Brightsphere', brightsphereLiveInput],
];

/** Two 8px labels centred on their rules overlap nearer than this. */
const CLEAR_PX = 9;
const AXIS = DEFAULT_CHART_PALETTE.axis.toLowerCase();

function panels(input: BoardPackInput) {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Trends')!;
  return page.blocks.flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : [])).map((p) => ({ id: p.id, svg: String(p.svg) }));
}

/** The zero rule, if one is drawn inside the scale and clear of its ends,
 *  and whether a value label stands on it. */
function zeroRule(svg: string): { y: number; labelled: boolean } | null {
  const ticks = [...svg.matchAll(/<text[^>]*text-anchor="end"[^>]*transform="translate\([-\d.]+ ([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)].map((m) => Number(m[1]));
  const rule = [...svg.matchAll(/<path d="M[-\d.]+ ([-\d.]+)L[-\d.]+ \1"[^>]*stroke="([^"]+)"/g)].find((m) => m[2]!.toLowerCase() === AXIS);
  if (rule === undefined || ticks.length < 2) return null;
  const y = Number(rule[1]);
  const ends = [Math.min(...ticks), Math.max(...ticks)];
  if (ends.some((e) => Math.abs(e - y) < CLEAR_PX)) return null;
  return { y, labelled: ticks.some((t) => Math.abs(t - y) <= 1) };
}

describe('a page-10 panel labels its zero line', () => {
  it.each(FIXTURES)('%s', (_name, input) => {
    const unlabelled = panels(input).flatMap((p) => {
      const zero = zeroRule(p.svg);
      return zero === null || zero.labelled ? [] : [`${p.id}: the zero rule at y=${zero.y} has no figure`];
    });
    expect(unlabelled).toEqual([]);
  });

  it('is reading the panels the review found: some panel draws a zero rule clear of its ends', () => {
    expect(FIXTURES.flatMap(([, input]) => panels(input)).filter((p) => zeroRule(p.svg) !== null).length).toBeGreaterThan(2);
  });
});
