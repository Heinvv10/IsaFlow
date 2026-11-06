/**
 * Page 6 of a net-debit-revenue company with a material interest/tax step, printed: the pack that
 * used to be refused at every scale is twelve sheets, page 6 sits inside its sheet, the derived
 * caption is gone and the omission footnote says so.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { log } from '@/lib/logger';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { page6Input, type Page6Shape } from '../services/packs/fixtures/page6Shapes';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const SHAPES: Array<[string, Page6Shape]> = [
  ['demo scale', { k: 1, negative: true, loss: false, plug: 0.2, sg: [1, 1, 1, 1] }],
  ['R1m scale, a loss', { k: 1000, negative: true, loss: true, plug: 0.2, sg: [1, 1, 1, 1] }],
  ['R300m scale', { k: 300000, negative: true, loss: false, plug: 0.2, sg: [1, 1, 1, 1] }],
];

describe.each(SHAPES)('net-debit revenue and a 20%% step, %s', (unused, shape) => {
  it('prints twelve sheets, page 6 inside its sheet, without the caption and with the omission note', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const doc = buildBoardPackPages(page6Input(shape));
      assertPackIntegrity(doc);
      const idx = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
      const printed = await printBoardPack(doc, browser);

      expect(printed.sheets).toBe(doc.pages.length);
      // Page 6 only: at R300m page 3 (highlights) runs past the right edge with or without this change.
      expect(printed.overflow.filter((o) => o.id === `pack-page-${idx + 1}`)).toEqual([]);
      // 0.2mm is the harness's own rounding (packSheetCount.test.ts).
      const height = printed.heights[idx]!;
      expect(height.overMm, `page 6 runs ${height.overMm}mm past its sheet`).toBeLessThanOrEqual(0.2);

      const sheet = printed.sheetText.find((t) => /Gross profit/.test(t) && /Net profit/.test(t))!.replace(/\s+/g, ' ');
      expect(sheet).toContain('Lines below zero');
      expect(sheet).toContain('How much of this bridge is unexplained');
      expect(sheet).toContain('1 derived caption');
      expect(sheet).not.toMatch(/moved the most in money/);
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});
