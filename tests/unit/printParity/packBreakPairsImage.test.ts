/**
 * THE PAIR TABLE IS PRODUCTION'S IMAGE'S, in a throwaway container of the image production's Gotenberg runs:
 *  - the splitter breaks where production's Chromium breaks, with nothing dropped, on the census and random strings
 *    (`print/fixtures/breakPairsCensus.ts`) and, as line counts, on the adversary's census of #1235's third round: where
 *    the print tests' Chromium differs from production's (`asProduction`), production's is the one held;
 *  - the stand-ins' other members beside the faces' punctuation, on every break;
 *  - the labels #1235's third round found short, in a statement table laid out at production's print width: never a
 *    label line too few, the height never short (the print tests' Chromium breaks some of them where production's does
 *    not, so `packTableLayout.test.ts` holds only the rest), never wider than the page, and no label past its cell
 *    (round 8); a table the fit refuses is never printed, and the pack is refused (`packFigureFloor`);
 *  - with REGENERATE_BREAK_PAIRS=1, the table itself is scanned afresh there (`breakPairsScan.scanPairs`, about three
 *    hours) and written to `packBreakPairsData.ts` (`breakPairsTable.ts`).
 * Fallback faces set the characters the pack's faces lack, and another Chromium or another host's fonts can move a
 * break: velo only, as the other break tables (`packBreakTablesImage.test.ts`). Re-run it whenever the gotenberg image
 * or the pack's fonts change.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { PAIR_CLASS_RANGES } from '@/modules/accounting/services/packs/pages/packBreakPairsData';
import { statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { carriesMarks, printedText, printsAnywhere } from '@/modules/accounting/services/packs/pages/packPrintedText';
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { unreadableBlock } from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { TABLES_OF } from '../print/measureTables';
import { atTheFloor } from '../print/support/atTheFloor';
import { demoWithoutBudget, withWidenedTable } from '../services/packs/fixtures/widenedFigures';
import { pairJobDocument, scanPairs, type PairJob } from './breakPairsScan';
import { PAIR_DOMAIN, seedOf } from './breakPairsDomain';
import { pairDataSource } from './breakPairsTable';
import { gotenbergPdf, startGotenberg, withPdfFile, type Gotenberg } from './gotenbergParity';
import { breaksInImage, inImage as runInImage } from './inImage';
import { flatStylesheet } from './parityPage';
import { paritySkip } from './paritySkip';
import { adversaryCensus, BREAKS_OF, CENSUS, heldLines, LINES_OF, linesHtml, modelBreaks, randomStrings, readBreaks, ROUND_FIVE_LABELS, ROUND_FOUR_LABELS, ROUND_SEVEN_LABELS, ROUND_SIX_LABELS, ROUND_THREE_LABELS } from '../print/fixtures/breakPairsCensus';
import { allDifferences, standInCensus } from '../print/fixtures/everyBreakCensus';
import { ROUND_EIGHT_FITTING, ROUND_EIGHT_LABELS, ROUND_NINE_LABELS } from '../print/fixtures/anywhereFamilies';

const DATA = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packBreakPairsData.ts');
const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

const inImage = (script: string, body?: string): Promise<string[]> => runInImage(gotenberg!, script, body);

const hexOf = (t: string): string => Array.from(t, (c) => c.codePointAt(0)!.toString(16)).join('.');
const textOf = (h: string): string => String.fromCodePoint(...h.split('.').map((c) => parseInt(c, 16)));

describe.skipIf(unavailable !== null)(`the break-pair table of production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('on the census and 3,000 random strings, the splitter breaks where production\'s Chromium breaks, and nowhere else', async () => {
    const texts = [...CENSUS, ...randomStrings(3000)];
    const wrong: string[] = [];
    let breaks = 0;
    for (let at = 0; at < texts.length; at += 15_000) {
      const slice = texts.slice(at, at + 15_000);
      const lines = await inImage(`${BREAKS_OF}\nfunction answer() { return breaksOf(${JSON.stringify(slice)}).map(function (b) { return 'B|' + b.join(','); }); }`);
      const got = lines.filter((l) => l.startsWith('B|')).map((l) => (l.length > 2 ? l.slice(2).split(',').map(Number) : []));
      expect(got.length, 'the image\'s census came back incomplete').toBe(slice.length);
      slice.forEach((t, i) => {
        const { real, blind } = readBreaks(t, got[i]!);
        const model = modelBreaks(t).filter((b) => !blind.has(b));
        breaks += real.length;
        if (real.join(',') !== model.join(',')) wrong.push(`${JSON.stringify(t)}: production ${real.join(',')} model ${model.join(',')}`);
      });
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${texts.length} differ`).toEqual([]);
    expect(breaks).toBeGreaterThan(3_000);
  }, 1_800_000);

  it('the stand-ins\' other members beside every punctuation mark and symbol the faces set, and the rules beside the table: every break is production\'s', async () => {
    const texts = standInCensus();
    const wrong = allDifferences(texts, await breaksInImage(gotenberg!, BREAKS_OF, texts));
    expect(wrong.map((t) => JSON.stringify(t)).slice(0, 20), `${wrong.length} of ${texts.length} differ`).toEqual([]);
  }, 1_800_000);

  it('on the adversary\'s census, as line counts with and without a mark, the model\'s lines are production\'s', async () => {
    // A label holding a mark is printed to break anywhere (`packAnywhereLabel.ts`): the pair table never reads it.
    const items = adversaryCensus().filter(({ text }) => !carriesMarks(printedText(text)));
    const wrong: string[] = [];
    for (let at = 0; at < items.length; at += 15_000) {
      const slice = items.slice(at, at + 15_000);
      const lines = await inImage(`${LINES_OF}\nfunction answer() { return linesOf(${JSON.stringify(slice.map(({ text, marked }) => linesHtml(text, marked)))}).map(function (n) { return 'N|' + n; }); }`);
      const got = lines.filter((l) => l.startsWith('N|')).map((l) => l.slice(2));
      expect(got.length, 'the image\'s census came back incomplete').toBe(slice.length);
      slice.forEach(({ text, marked }, i) => {
        const { chromium, model } = heldLines(text, marked, got[i]!);
        if (model !== chromium) wrong.push(`${hexOf(text)}${marked ? '^1' : ''}: production ${chromium} model ${model}`);
      });
    }
    expect(wrong.slice(0, 20).map((w) => w.replace(/^[0-9a-f.]+/, (h) => JSON.stringify(textOf(h)))), `${wrong.length} of ${items.length} differ`).toEqual([]);
  }, 1_800_000);

  it('the round-3 to round-8 labels in a statement table, in production: never a label line too few, the height never short, never wider than the page, no label past its cell', async () => {
    // The print tests' Chromium breaks after a word-opening en dash where production's does not: this is where those are held.
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let held = 0;
    const labels = [...ROUND_THREE_LABELS, ...ROUND_FOUR_LABELS, ...ROUND_FIVE_LABELS, ...ROUND_SIX_LABELS, ...ROUND_SEVEN_LABELS, ...ROUND_EIGHT_LABELS, ...ROUND_EIGHT_FITTING, ...ROUND_NINE_LABELS];
    const refused: string[] = [];
    for (const [label, labelMarker] of labels) {
      for (const digits of [9, 12]) {
        const { doc, table, index } = withWidenedTable(demoWithoutBudget(), digits, label, { labelMarker });
        const page = doc.pages[index]!.number;
        const say = `${JSON.stringify(label)}${labelMarker ? '^1' : ''}, ${digits} digits`;
        held += 1;
        const fits = table.figureFit?.fits === true;
        // A table the fit refuses (a grapheme wider than the room the figures leave its label) never prints: the pack
        // is refused, never set with the label over the figures. Printed anyway (`atTheFloor`), it runs past the page.
        if (!fits && unreadableBlock(doc.pages[index]!, doc.numberConvention.scale)?.kind !== 'table') wrong.push(`${say}: the fit refuses it, the pack does not`);
        const body = renderToStaticMarkup(createElement(PackPagesView, { document: atTheFloor(doc) }));
        // How far any label printed to break anywhere runs past its cell's right edge (into the figures), in px.
        const overrun = `Math.max.apply(null, [-1e9].concat(Array.from(document.querySelectorAll('.pack-label-anywhere')).map(function (s) { var r = document.createRange(); r.selectNodeContents(s); var right = -1e9; Array.from(r.getClientRects()).forEach(function (x) { right = Math.max(right, x.right); }); return right - s.closest('td').getBoundingClientRect().right; })))`;
        const lines = await inImage(`${TABLES_OF}\nfunction answer() { var over = ${overrun}; return tablesOf(${96 / 25.4}).filter(function (t) { return t.page === ${page}; }).map(function (t) { return 'T|' + t.heightMm + '|' + t.labelLines.join(',') + '|' + t.columnsPx.reduce(function (a, b) { return a + b; }, 0) + '|' + t.columnsPx[0] + '|' + over; }); }`, body);
        const [, heightMm, labelLines, widthPx, labelPx, overPx] = lines.find((l) => l.startsWith('T|'))?.split('|') ?? [];
        expect(labelLines, `${JSON.stringify(label)}: the image's table came back incomplete`).toBeDefined();
        const real = labelLines!.split(',').map(Number);
        const model = tableLayout(table, doc.numberConvention.scale, 'portrait');
        if (!fits) {
          // The fit counts widths never under Chromium's, so a refusal can be a pixel or two early, never late.
          if (Number(widthPx) <= PRINT_CONTENT_PX.portrait - 2) wrong.push(`${say}: refused, yet ${Number(widthPx).toFixed(3)}px wide in production`);
          refused.push(`${say} (${Number(widthPx).toFixed(1)}px)`);
          continue;
        }
        expect(real.length === model.labelLines.length && real.every((l) => l >= 1) && Number(heightMm) > 10, `${JSON.stringify(label)}: read ${lines.find((l) => l.startsWith('T|'))}`).toBe(true);
        if (model.labelLines.some((l, r) => l < real[r]!)) wrong.push(`${say}: lines ${model.labelLines} vs production ${real}`);
        const height = statementTableBodyMm(table, doc.numberConvention.scale, 'portrait');
        if (height < Number(heightMm)) wrong.push(`${say}: height short, model ${height.toFixed(2)}mm vs production ${Number(heightMm).toFixed(2)}`);
        // A table the model passes (`tableFit`) must fit the page in production: a label column too narrow widens it.
        // The label column never narrower than production's (a mark the faces lack is drawn: round 6).
        // A label holding a mark holds its column at its floor and no more, in the model and in the print (`packAnywhereLabel.ts`).
        if (printsAnywhere(printedText(label)) && Math.abs(model.columnsPx[0]! - Number(labelPx)) > 0.1) wrong.push(`${say}: label column ${model.columnsPx[0]!.toFixed(3)}px, production ${Number(labelPx).toFixed(3)}, a marked label moved it`);
        if (model.columnsPx[0]! < Number(labelPx) - 0.1) wrong.push(`${say}: label column ${model.columnsPx[0]!.toFixed(3)}px, production ${Number(labelPx).toFixed(3)}`);
        if (Number(widthPx) > PRINT_CONTENT_PX.portrait + 0.02) wrong.push(`${say}: ${Number(widthPx).toFixed(3)}px wide in production, past the page's ${PRINT_CONTENT_PX.portrait}`);
        if (Number(overPx) > 0) wrong.push(`${say}: the label runs ${Number(overPx).toFixed(1)}px past its cell, over the figures`);
      }
    }
    process.stdout.write(`ROUND LABELS refused ${refused.length}: ${refused.join('; ')}\n`);
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(held, 'labels held').toBe(labels.length * 2);
  }, 1_800_000);

  it.skipIf(process.env.REGENERATE_BREAK_PAIRS !== '1')('REGENERATE_BREAK_PAIRS=1: scans the table afresh and writes packBreakPairsData.ts', async () => {
    const { css, fonts } = flatStylesheet();
    const run = async (job: PairJob): Promise<string[]> => {
      const pdf = await gotenbergPdf(gotenberg!, pairJobDocument(css, job), fonts, 'window.parityDone === true');
      return withPdfFile(pdf, (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).split('\n');
    };
    const scan = await scanPairs(run, PAIR_DOMAIN(), seedOf(PAIR_CLASS_RANGES), (line) => process.stdout.write(`BREAK PAIRS ${line}\n`));
    writeFileSync(DATA, pairDataSource(scan));
  }, 14_400_000);
});
