/**
 * ROW LABELS PRINTED TO BREAK ANYWHERE, IN THE PRINT TESTS' CHROMIUM (#1235 round 8): the CI half of
 * `printParity/packAnywhereLabelImage.test.ts`, which holds the same in production's image.
 *  - Graphemes that hold several glyphs that advance, with a footnote mark after them and without (blind L2: a mark on
 *    such a label was held nowhere): never a line more than the model, none past its block, the block the model's.
 *  - Statement tables whose labels all carry marks, or every other one (blind M1: the label column fell to its
 *    padding): the columns are the model's, the lines and the height never short.
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
import { anywhereFamilies } from './fixtures/anywhereFamilies';
import { MARKED_TABLES, relabelledStatement } from './fixtures/markedTables';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const COLUMN_ERROR_PX = 0.1;

describe('a label printed to break anywhere, in Chromium', () => {
  it('the round-8 families, with a footnote mark and without, at seven widths and three weights: never a line more than the model, none past its block', async () => {
    const texts = anywhereFamilies().map(printedText).filter(printsAnywhere);
    const cases: AnywhereCase[] = texts.flatMap((text) => [null, 1, 12].map((footnote) => ({ text, footnote })));
    const page = await openProbePage(browser);
    const wrong: string[] = [];
    try {
      for (const weight of [400, 500, 600] as const) {
        for (const w of [18, 140, 200, 230, 260, 320, 400]) {
          const lines = await page.evaluate(`(function () { ${ANYWHERE_LINES_OF}; return anywhereLines(document.body, ${anywhereArgs(cases, weight)}, ${w}, ${weight}); })()`) as string[];
          wrong.push(...judgeAnywhere(cases, lines, w, weight));
        }
      }
    } finally {
      await page.close();
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${cases.length * 21}`).toEqual([]);
  }, 900_000);
});

describe('a statement table whose labels carry marks, in Chromium', () => {
  it('all marked, every other one marked, footnoted: the columns the model\'s, the lines and the height never short', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    for (const [name, relabel] of MARKED_TABLES) {
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
