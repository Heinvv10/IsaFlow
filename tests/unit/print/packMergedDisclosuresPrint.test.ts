/**
 * Page 6 of a company with net-debit revenue, another line below zero and a material interest/tax
 * step, printed: the pack that was refused (256 to 261mm of 255mm) is twelve sheets, page 6 sits
 * inside its sheet, and both required notes are on it under "Required disclosures".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { page6Input, type Page6Shape } from '../services/packs/fixtures/page6Shapes';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const SHAPES: Array<[string, Page6Shape]> = [
  ['R30 scale, three lines below zero', { k: 30, negative: true, loss: false, plug: 0.2, sg: [-1, 1, -1, -1] }],
  ['R1m scale, a loss', { k: 1000, negative: true, loss: true, plug: 0.05, sg: [1, -1, 1, -1] }],
  ['R300m scale', { k: 300000, negative: true, loss: false, plug: 0.2, sg: [1, -1, -1, 1] }],
];

describe.each(SHAPES)('merged required disclosures, %s', (unused, shape) => {
  it('prints twelve sheets, page 6 inside its sheet, both notes under one heading', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
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
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});
