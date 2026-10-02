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
import { smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import { panelAxisLabels } from '@/modules/accounting/services/packs/pages/packPanelZero';
import { PANEL } from '@/modules/accounting/services/packs/pages/packTrendPanelSet';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { formatPctLevel } from '@/lib/format/money';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput, liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const tickLabels = (svg: string) => [...svg.matchAll(/<text[^>]*text-anchor="end"[^>]*transform="translate\([-\d.]+ ([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)]
  .map((m) => ({ y: Number(m[1]), text: m[2]!.replace(/\u00a0/g, ' ') }));

/** A gross-margin panel as the v79 demo packs drew it: 5 323.5%, (1 138.7%), 100.0%. */
function grossMarginPanel(values: number[]): string {
  const points = values.map((value, i) => ({ label: `M${i + 1}`, value }));
  const domain = { min: Math.min(0, ...values), max: Math.max(0, ...values) };
  return String(renderChartSvg(panelAxisLabels(smallMultipleOption(points, domain, formatPctLevel, undefined, { endpoints: true }), domain), PANEL));
}

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the demo company', demoInput],
  ['the live demo company, long window', liveDemoInput],
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['the live demo company, short panels', liveDemoShortPanelsInput],
  ['Brightsphere', brightsphereLiveInput],
];

/** Two 8px labels centred on their rules: a label's height of air between
 *  them. At 11.6px v79's "0.0%" sat on "(1 138.7%)". */
const CLEAR_PX = 16;
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

  it('skips the zero label within a label\'s height of air of an end label: v79\'s gross margin', () => {
    expect(tickLabels(grossMarginPanel([5_323.5, -1_138.7, 100])).map((t) => t.text)).toEqual(['(1 138.7%)', '5 323.5%']);
  });

  it('labels zero with the pack\'s dash, not "0.0%", where it stands clear', () => {
    expect(tickLabels(grossMarginPanel([50, -50, 20])).map((t) => t.text)).toEqual(['(50.0%)', '–', '50.0%']);
  });

  it.each(FIXTURES)('every panel prints zero as the dash, and no two labels nearer than the clearance — %s', (_name, input) => {
    const found = panels(input).flatMap((p) => {
      const ticks = tickLabels(p.svg).sort((a, b) => a.y - b.y);
      return [
        ...ticks.filter((t) => /^0(\.0+)?(%| days)?$/.test(t.text)).map((t) => `${p.id}: zero printed as "${t.text}"`),
        ...ticks.slice(1).filter((t, i) => t.y - ticks[i]!.y < CLEAR_PX).map((t, i) => `${p.id}: "${ticks[i]!.text}" and "${t.text}" ${(t.y - ticks[i]!.y).toFixed(1)}px apart`),
      ];
    });
    expect(found).toEqual([]);
  });
});
