/**
 * ROW LABELS PRINTED TO BREAK ANYWHERE, IN THE PRINT TESTS' CHROMIUM (#1235 round 8): the CI half of
 * `printParity/packAnywhereLabelImage.test.ts`, which holds the same in production's image.
 *  - The families' labels the pack's own faces set (the footnote-mark sweep), with a footnote mark after them and
 *    without (blind L2: a mark on such a label was held nowhere): never a line more than the model, none past its block,
 *    the block the model's. The families a fallback face sets are the image test's alone: this Chromium sets them in the
 *    host's fallback fonts, which are not production's (#1235 merge queue, 3033bed38: GitHub's runner).
 *  - A long run the faces set and then a marked grapheme, at every width from the floor to 214px (round 13: a fit bound
 *    loosened by 3px passed every test): never a line more than the model.
 *  - Statement tables whose labels all carry marks, or every other one (blind M1: the label column fell to its
 *    padding), of text the faces set: the columns are the model's, the lines and the height never short. The tables in
 *    scripts the faces lack are the image test's.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { log } from '@/lib/logger';
import { printedText, printsAnywhere } from '@/modules/accounting/services/packs/pages/packPrintedText';
import { statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { launchPrintChromium } from './printChromium';
import { openProbePage } from './measureWidths';
import { measureTables } from './measureTables';
import { ANYWHERE_LINES_OF, anywhereArgs, judgeAnywhere, type AnywhereCase } from './anywhereLines';
import { anywhereFamilies, footnoteSweep, TAIL_WIDTHS, tailSweep } from './fixtures/anywhereFamilies';
import { inFaces } from './fixtures/breakPairsCensus';
import { fallbackFamilies } from './fixtures/fallbackFamilies';
import { MARKED_TABLES, relabelledStatement } from './fixtures/markedTables';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const COLUMN_ERROR_PX = 0.1;

/** What is wrong with `cases` set in this Chromium at each of `widths` and every weight (`anywhereLines.judgeAnywhere`). */
async function wrongIn(cases: readonly AnywhereCase[], widths: readonly number[]): Promise<string[]> {
  const page = await openProbePage(browser);
  const wrong: string[] = [];
  try {
    for (const weight of [400, 500, 600] as const) {
      for (const w of widths) {
        const lines = await page.evaluate(`(function () { ${ANYWHERE_LINES_OF}; return anywhereLines(document.body, ${anywhereArgs(cases, weight)}, ${w}, ${weight}); })()`) as string[];
        wrong.push(...judgeAnywhere(cases, lines, w, weight));
      }
    }
  } finally {
    await page.close();
  }
  return wrong.slice(0, 20);
}

describe('a label printed to break anywhere, in Chromium', () => {
  it('the footnote-mark sweep and the separators and marked hyphens #1235 deferred (the families\' labels the pack\'s faces set), with a footnote mark and without, at seven widths and three weights: never a line more than the model, none past its block', async () => {
    // Only labels the pack's own faces set: how a fallback face sets a glyph is the host's (GitHub's runner sets Syriac's
    // final SADHE wide enough to run 1.078px past its block; production never runs past it), so the fallback families are
    // held to production's image, velo only (`printParity/packAnywhereLabelImage.test.ts`, the same families).
    const texts = anywhereFamilies().map(printedText).filter(printsAnywhere).filter(inFaces);
    // The faces set the separators and the marked hyphens #1235 deferred (27), the runs kerned across ZWNJ, ZWJ and
    // ZWNBSP (#1261, 18) and the footnote-mark sweep (160).
    const deferred = fallbackFamilies().map(printedText).filter(printsAnywhere).filter(inFaces);
    expect(deferred.length).toBe(45);
    expect(texts, 'the families\' labels the faces set are the deferred separators and marked hyphens and the footnote-mark sweep, and only them').toEqual([...deferred, ...footnoteSweep()]);
    const cases: AnywhereCase[] = texts.flatMap((text) => [null, 1, 12].map((footnote) => ({ text, footnote })));
    expect(await wrongIn(cases, [18, 140, 200, 230, 260, 320, 400])).toEqual([]);
  }, 900_000);

  it('a long run the faces set and then a marked grapheme, at every width from the floor to 214px and three weights: never a line more than the model', async () => {
    const cases: AnywhereCase[] = tailSweep().map((text) => ({ text, footnote: null }));
    expect(cases.every(({ text }) => inFaces(text) && printsAnywhere(text))).toBe(true);
    expect(await wrongIn(cases, TAIL_WIDTHS)).toEqual([]);
  }, 900_000);
});

describe('a statement table whose labels carry marks, in Chromium', () => {
  it('the tables the faces set, all marked and every other one marked and footnoted: the columns the model\'s, the lines and the height never short', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    // Only the tables the pack's faces set: a fallback face is the host's (the rest are production's image's).
    const tables = MARKED_TABLES.filter(([name, relabel]) => name !== 'plain' && relabelledStatement(relabel).table.rows.every((row) => inFaces(row.label)));
    expect(tables.map(([name]) => name)).toEqual(['all with a combining accent', 'every other label with a combining accent, footnoted']);
    for (const [name, relabel] of tables) {
      const { doc, table, index } = relabelledStatement(relabel);
      expect(table.figureFit?.fits, name).toBe(true);
      const real = (await measureTables(doc, browser)).filter((t) => t.page === doc.pages[index]!.number)[0]!;
      const model = tableLayout(table, doc.numberConvention.scale, 'portrait');
      model.columnsPx.forEach((px, c) => { if (Math.abs(px - real.columnsPx[c]!) > COLUMN_ERROR_PX) wrong.push(`${name}: column ${c} model ${px.toFixed(3)} vs ${real.columnsPx[c]!.toFixed(3)}`); });
      if (model.labelLines.some((l, r) => l < real.labelLines[r]!)) wrong.push(`${name}: lines ${model.labelLines} vs ${real.labelLines}`);
      const height = statementTableBodyMm(table, doc.numberConvention.scale, 'portrait');
      if (height < real.heightMm) wrong.push(`${name}: height short, model ${height.toFixed(2)}mm vs Chromium ${real.heightMm.toFixed(2)}`);
    }
    expect(wrong).toEqual([]);
  }, 600_000);
});
