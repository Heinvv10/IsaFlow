/**
 * THE PAIR TABLE IS PRODUCTION'S IMAGE'S, in a throwaway container of the image production's Gotenberg runs:
 *  - the splitter breaks where production's Chromium breaks, with nothing dropped, on the census and random strings
 *    (`print/fixtures/breakPairsCensus.ts`) and, as line counts, on the adversary's census of #1235's third round: where
 *    the print tests' Chromium differs from production's (`asProduction`), production's is the one held;
 *  - every character the table covers with a variation selector 16 after it, read by its base, but for the 13 known;
 *  - the labels #1235's third round found short, in a statement table laid out at production's print width: never a
 *    label line too few, the height never short (the print tests' Chromium breaks some of them where production's does
 *    not, so `packTableLayout.test.ts` holds only the rest);
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
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { TABLES_OF } from '../print/measureTables';
import { atTheFloor } from '../print/support/atTheFloor';
import { demoWithoutBudget, withWidenedTable } from '../services/packs/fixtures/widenedFigures';
import { pairJobDocument, scanPairs, type PairJob } from './breakPairsScan';
import { PAIR_DOMAIN, seedOf } from './breakPairsDomain';
import { pairDataSource } from './breakPairsTable';
import { gotenbergPdf, startGotenberg, withPdfFile, type Gotenberg } from './gotenbergParity';
import { flatStylesheet } from './parityPage';
import { paritySkip } from './paritySkip';
import { adversaryCensus, BREAKS_OF, CENSUS, heldLines, LINES_OF, linesHtml, modelBreaks, randomStrings, readBreaks, ROUND_THREE_LABELS, VS16_CENSUS, vs16Differences, VS16_RESIDUAL } from '../print/fixtures/breakPairsCensus';

const DATA = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packBreakPairsData.ts');
const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

const PROBE_BODY = '<div class="pack-pages"><div class="pack-page"><div id="scan"></div></div></div>';

/**
 * `script` (defining `answer()`, which returns lines) run in Gotenberg over the pack's stylesheet and `body` (a page to
 * probe in, or a pack's pages laid out at production's print width), its lines read back.
 */
async function inImage(script: string, body = PROBE_BODY): Promise<string[]> {
  const { css, fonts } = flatStylesheet();
  const run = `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  ${script}
  var lines = answer();
  document.documentElement.className = ''; document.head.innerHTML = ''; document.body.innerHTML = '';
  var pre = document.createElement('pre'); pre.style.cssText = 'font:7px monospace;white-space:pre;margin:0';
  pre.textContent = lines.join('\\n'); document.body.appendChild(pre);
  window.parityDone = true;
})();`;
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${css}html{width:${PRINT_CONTENT_PX.portrait}px}</style></head><body>${body}<script>${run}</script></body></html>`;
  const pdf = await gotenbergPdf(gotenberg!, html, fonts, 'window.parityDone === true');
  return withPdfFile(pdf, (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).split('\n').map((l) => l.trim());
}

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

  it('every character with a variation selector 16 after it, in five contexts: the model breaks where production\'s Chromium breaks, but for the known', async () => {
    const lines = await inImage(`${BREAKS_OF}\nfunction answer() { return breaksOf(${JSON.stringify(VS16_CENSUS)}).map(function (b) { return 'B|' + b.join(','); }); }`);
    const got = lines.filter((l) => l.startsWith('B|')).map((l) => (l.length > 2 ? l.slice(2).split(',').map(Number) : []));
    expect(got.length, 'the image\'s census came back incomplete').toBe(VS16_CENSUS.length);
    const wrong = vs16Differences(VS16_CENSUS, got);
    expect(wrong.filter((t) => !VS16_RESIDUAL.has(t)).map((t) => JSON.stringify(t)).slice(0, 20)).toEqual([]);
    expect(wrong.length).toBe(VS16_RESIDUAL.size);
  }, 1_800_000);

  it('on the adversary\'s census, as line counts with and without a mark, the model\'s lines are production\'s', async () => {
    const items = adversaryCensus();
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

  it('the round-3 labels in a statement table, in production: never a label line too few, the height never short', async () => {
    // The print tests' Chromium breaks after a word-opening en dash where production's does not: this is where those are held.
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let held = 0;
    for (const [label, labelMarker] of ROUND_THREE_LABELS) {
      for (const digits of [9, 12]) {
        const { doc, table, index } = withWidenedTable(demoWithoutBudget(), digits, label, { labelMarker });
        const page = doc.pages[index]!.number;
        const body = renderToStaticMarkup(createElement(PackPagesView, { document: atTheFloor(doc) }));
        const lines = await inImage(`${TABLES_OF}\nfunction answer() { return tablesOf(${96 / 25.4}).filter(function (t) { return t.page === ${page}; }).map(function (t) { return 'T|' + t.heightMm + '|' + t.labelLines.join(','); }); }`, body);
        const [, heightMm, labelLines] = lines.find((l) => l.startsWith('T|'))?.split('|') ?? [];
        expect(labelLines, `${JSON.stringify(label)}: the image's table came back incomplete`).toBeDefined();
        const real = labelLines!.split(',').map(Number);
        const model = tableLayout(table, doc.numberConvention.scale, 'portrait');
        expect(real.length === model.labelLines.length && real.every((l) => l >= 1) && Number(heightMm) > 10, `${JSON.stringify(label)}: read ${lines.find((l) => l.startsWith('T|'))}`).toBe(true);
        const say = `${JSON.stringify(label)}${labelMarker ? '^1' : ''}, ${digits} digits`;
        if (model.labelLines.some((l, r) => l < real[r]!)) wrong.push(`${say}: lines ${model.labelLines} vs production ${real}`);
        const height = statementTableBodyMm(table, doc.numberConvention.scale, 'portrait');
        if (height < Number(heightMm)) wrong.push(`${say}: height short, model ${height.toFixed(2)}mm vs production ${Number(heightMm).toFixed(2)}`);
        held += 1;
      }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(held, 'labels held').toBe(ROUND_THREE_LABELS.length * 2);
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
