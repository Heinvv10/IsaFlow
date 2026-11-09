/**
 * A ROW LABEL THAT CARRIES A MARK, IN PRODUCTION'S IMAGE: set in the statement table's own label cell
 * (`pack-label-anywhere`, the pack's stylesheet, at the `min-width` the table's fit stamps: `anywhereFloorPx`) at
 * several widths and three weights, its lines are never more than the model's (`packTableLayout.labelLineCount`, which
 * reads such a label by `packAnywhereLabel.ts`, the column as wide as the floor holds it), and no line runs past the
 * block (round 8: a grapheme the print cannot break was wider than its column and ran over the figures). The labels:
 * every combining mark and variation selector Unicode has, on bases whose fallback glyph is wider than the face's
 * (#1235 round 7: \u00AE | \u2122 \u2014 \u0640 M and the rest) and on ASCII and Latin-1 signs, alone, doubled and
 * inside a word; the marked census (`everyBreakCensus.markedCensus`); and graphemes that hold several glyphs that
 * advance (`anywhereFamilies`, round 8), with a footnote mark and without, at more widths. And statement tables whose
 * labels all carry marks (`markedTables`, blind round 8 M1): columns, lines, height, page and cells, and their height
 * against the plain table's. The round labels' tables are `packBreakPairsImage.test.ts`'s. Velo only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { asStamped } from '@/modules/accounting/services/packs/pages/packFigureFitCss';
import { TABLES_OF } from '../print/measureTables';
import { MARKED_TABLES, relabelledStatement } from '../print/fixtures/markedTables';
import { printedText, printsAnywhere } from '@/modules/accounting/services/packs/pages/packPrintedText';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { markedCensus } from '../print/fixtures/everyBreakCensus';
import { anywhereFamilies, joiningSweep, TAIL_WIDTHS, tailSweep } from '../print/fixtures/anywhereFamilies';
import { ANYWHERE_LINES_OF, anywhereArgs, judgeAnywhere, type AnywhereCase, type Weight } from '../print/anywhereLines';

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

/** The bases a mark is tried on: the round-7 reviews' widest-fallback ones, signs, letters. */
const BASES = ['\u00AE', '|', '\u2122', '\u2014', '\u0640', 'M', 'W', '\u00A6', '\u0448', '\u01B0', '\u2211', '\u2192', '\u00B6', '\u00D7', '?', '/', '!', '}', '\u00B0', '\u00A3', 'n', 'A', '1', '&'];

function labels(): string[] {
  const out = new Set<string>();
  for (let cp = 0x300; cp <= 0x1ffff; cp += 1) {
    const m = String.fromCodePoint(cp);
    if (!/^\p{M}$/u.test(m)) continue;
    for (const b of BASES) { out.add(`${b}${m}`); out.add(`${b}${m}${b}${m}`); }
    out.add(`Telecom\u00AE${m}munications`);
  }
  for (const t of markedCensus()) out.add(t);
  return printedMarked([...out]);
}

const printedMarked = (texts: readonly string[]): string[] => texts.map(printedText).filter(printsAnywhere);

/** Every width under the floor (174px and up) is the floor; the families are wider, so they are tried wider too. */
const WIDTHS = [18, 200, 250, 400];
const FAMILY_WIDTHS = [18, 120, 140, 200, 210, 220, 230, 250, 260, 320, 400, 480];

/** Each of `cases` at `w` and `weight` in the image (`anywhereLines.ts`): what is wrong. */
async function check(cases: readonly AnywhereCase[], w: number, weight: Weight): Promise<string[]> {
  const wrong: string[] = [];
  for (let at = 0; at < cases.length; at += 6000) {
    const slice = cases.slice(at, at + 6000);
    const lines = await inImage(gotenberg!, `${ANYWHERE_LINES_OF}\nfunction answer() { return anywhereLines(document.getElementById('scan'), ${anywhereArgs(slice, weight)}, ${w}, ${weight}); }`);
    wrong.push(...judgeAnywhere(slice, lines, w, weight));
  }
  return wrong;
}

describe.skipIf(unavailable !== null)(`labels printed to break anywhere, in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('every mark on wide-fallback bases and signs, and the marked census, at four widths and three weights: never a line more than the model, none past its block', async () => {
    const cases = labels().map((text) => ({ text, footnote: null }));
    expect(cases.length).toBeGreaterThan(100_000);
    const wrong: string[] = [];
    for (const weight of [400, 500, 600] as const) for (const w of WIDTHS) wrong.push(...await check(cases, w, weight));
    expect(wrong.slice(0, 20), `${wrong.length} of ${cases.length * 12}`).toEqual([]);
  }, 3_600_000);

  it('graphemes that hold several glyphs that advance (round 8), with and without a footnote mark, at twelve widths and three weights: never a line more, none past its block', async () => {
    const texts = printedMarked(anywhereFamilies());
    expect(texts.length).toBeGreaterThan(900);
    const cases = texts.flatMap((text) => [null, 1, 12].map((footnote) => ({ text, footnote })));
    const wrong: string[] = [];
    for (const weight of [400, 500, 600] as const) for (const w of FAMILY_WIDTHS) wrong.push(...await check(cases, w, weight));
    expect(wrong.slice(0, 20), `${wrong.length} of ${cases.length * 36}`).toEqual([]);
  }, 3_600_000);

  it('a long run the faces set and then a marked grapheme (round 13), at every width from the floor to 214px and three weights: never a line more, none past its block', async () => {
    const cases = tailSweep().map((text) => ({ text, footnote: null }));
    const wrong: string[] = [];
    for (const weight of [400, 500, 600] as const) for (const w of TAIL_WIDTHS) wrong.push(...await check(cases, w, weight));
    expect(wrong.slice(0, 20), `${wrong.length} of ${cases.length * TAIL_WIDTHS.length * 3}`).toEqual([]);
  }, 1_800_000);

  it('every joining letter the faces lack, repeated and paired, alone and after a marked word (round 9), at three widths and three weights: never a line more, none past its block', async () => {
    const cases = printedMarked(joiningSweep()).map((text) => ({ text, footnote: null }));
    expect(cases.length).toBeGreaterThan(40_000);
    const wrong: string[] = [];
    for (const weight of [400, 500, 600] as const) for (const w of [18, 200, 320]) wrong.push(...await check(cases, w, weight));
    expect(wrong.slice(0, 20), `${wrong.length} of ${cases.length * 9}`).toEqual([]);
  }, 3_600_000);

  it('statement tables whose labels all carry marks, or every other one: the columns the model\'s, never short, never past the page or a cell, and as tall as the plain table', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    const heights: string[] = [];
    let plainMm = 0;
    for (const [name, relabel] of MARKED_TABLES) {
      const { doc, table, index } = relabelledStatement(relabel);
      expect(table.figureFit?.fits, name).toBe(true);
      const body = renderToStaticMarkup(createElement(PackPagesView, { document: asStamped(doc) }));
      const overrun = `Math.max.apply(null, [-1e9].concat(Array.from(document.querySelectorAll('.pack-label-anywhere')).map(function (s) { var r = document.createRange(); r.selectNodeContents(s); var right = -1e9; Array.from(r.getClientRects()).forEach(function (x) { right = Math.max(right, x.right); }); return right - s.closest('td').getBoundingClientRect().right; })))`;
      const lines = await inImage(gotenberg!, `${TABLES_OF}\nfunction answer() { var over = ${overrun}; return tablesOf(${96 / 25.4}).filter(function (t) { return t.page === ${doc.pages[index]!.number}; }).map(function (t) { return 'T|' + t.heightMm + '|' + t.labelLines.join(',') + '|' + t.columnsPx.join(',') + '|' + over; }); }`, body);
      const [, heightMm, labelLines, columnsPx, overPx] = lines.find((l) => l.startsWith('T|'))?.split('|') ?? [];
      expect(columnsPx, `${name}: the image's table came back incomplete`).toBeDefined();
      const real = { heightMm: Number(heightMm), labelLines: labelLines!.split(',').map(Number), columnsPx: columnsPx!.split(',').map(Number) };
      const model = tableLayout(table, doc.numberConvention.scale, 'portrait');
      const height = statementTableBodyMm(table, doc.numberConvention.scale, 'portrait');
      if (name === 'plain') plainMm = real.heightMm;
      heights.push(`${name} ${real.heightMm.toFixed(2)}mm (model ${height.toFixed(2)})`);
      model.columnsPx.forEach((px, c) => { if (Math.abs(px - real.columnsPx[c]!) > 0.1) wrong.push(`${name}: column ${c} model ${px.toFixed(3)} vs production ${real.columnsPx[c]!.toFixed(3)}`); });
      if (model.labelLines.some((l, r) => l < real.labelLines[r]!)) wrong.push(`${name}: lines ${model.labelLines} vs production ${real.labelLines}`);
      if (height < real.heightMm) wrong.push(`${name}: height short, model ${height.toFixed(2)}mm vs production ${real.heightMm.toFixed(2)}`);
      if (real.columnsPx.reduce((a, b) => a + b, 0) > PRINT_CONTENT_PX.portrait + 0.02) wrong.push(`${name}: wider than the page in production`);
      if (Number(overPx) > 0) wrong.push(`${name}: a label runs ${Number(overPx).toFixed(1)}px past its cell`);
      // Round 7 printed the all-Thai table at 183mm against the plain one's 69: within one label line of it now.
      if (real.heightMm > plainMm + 4.59) wrong.push(`${name}: ${real.heightMm.toFixed(2)}mm in production against the plain table's ${plainMm.toFixed(2)}`);
    }
    process.stdout.write(`MARKED TABLES ${heights.join('; ')}\n`);
    expect(wrong).toEqual([]);
  }, 1_800_000);
});
