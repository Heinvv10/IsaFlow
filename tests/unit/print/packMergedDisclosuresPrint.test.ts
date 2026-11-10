/**
 * Page 6 of a company with net-debit revenue, another line below zero and a material interest/tax
 * step, printed: the pack that was refused (256 to 261mm of 255mm) is twelve sheets, page 6 sits
 * inside its sheet, and both required notes are on it under "Required disclosures".
 *
 * Since prose is set at its own widths no shape of the 2,560 is refused apart, so none reaches the merge: page 6 is
 * crowded here by a REQUIRED footnote of a few sentences (`fixtures/page6Crowded`), passed to the real
 * `incomeSheetWithBudget` beside the statement notes, and the rest of the pack is built and printed as it always is.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { CROWDING_SENTENCE } from '../services/packs/fixtures/page6Crowded';
import { page6Input, type Page6Shape } from '../services/packs/fixtures/page6Shapes';
import { printBoardPack } from './renderPackPdf';

/** How many sentences of the required footnote page 6 carries (0: none). */
const crowding = vi.hoisted(() => ({ sentences: 0 }));
vi.mock('@/modules/accounting/services/packs/pages/packIncomeBudget', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/packs/pages/packIncomeBudget')>();
  return {
    ...real,
    incomeSheetWithBudget: (...[income, set, scale, panels, notes]: Parameters<typeof real.incomeSheetWithBudget>) => real.incomeSheetWithBudget(
      income, set, scale, panels,
      crowding.sentences === 0 ? notes : [...notes, { number: notes.length + 1, text: CROWDING_SENTENCE.repeat(crowding.sentences), required: true }]),
  };
});

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const NET_DEBIT_TWO_LINES = (k: number): Page6Shape => ({ k, negative: true, loss: false, plug: 0.2, sg: [-1, 1, -1, -1] });
// Each the fewest sentences that leave the page only the merge (one fewer fits apart; demo scale is refused at five).
const SHAPES: Array<[string, Page6Shape, number]> = [
  ['demo scale, three sentences', NET_DEBIT_TWO_LINES(1), 3],
  ['R2m scale, one sentence', NET_DEBIT_TWO_LINES(2000), 1],
];

describe.each(SHAPES)('merged required disclosures, %s', (unused, shape, sentences) => {
  it('prints twelve sheets, page 6 inside its sheet, both notes under one heading', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      crowding.sentences = sentences - 1;
      const apart = buildBoardPackPages(page6Input(shape)).pages.find((p) => p.navLabel === 'Income statement')!;
      expect(apart.blocks.filter((b) => b.kind === 'disclosure'), 'one sentence fewer must fit apart').toHaveLength(2);
      crowding.sentences = sentences;
      const doc = buildBoardPackPages(page6Input(shape));
      assertPackIntegrity(doc);
      const idx = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
      const printed = await printBoardPack(doc, browser);

      expect(printed.sheets).toBe(doc.pages.length);
      // Page 6 only: at R300m page 3 (highlights) runs past the right edge with or without this change.
      expect(printed.overflow.filter((o) => o.id === `pack-page-${idx + 1}`)).toEqual([]);
      const height = printed.heights[idx]!;
      expect(height.overMm, `page 6 runs ${height.overMm}mm past its sheet`).toBeLessThanOrEqual(0.2);

      const sheet = printed.sheetText.find((t) => /Gross profit/.test(t) && /Net profit/.test(t))!.replace(/\s+/g, ' ');
      expect(sheet).toContain('Required disclosures');
      expect(sheet).toContain('What this means');
      expect(sheet).toContain('Size of the unexplained step');
      expect(sheet).not.toContain('Lines below zero');
      expect(sheet, 'the crowding footnote is on the sheet').toContain('The prior column is the comparative period the basis page states');
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});
