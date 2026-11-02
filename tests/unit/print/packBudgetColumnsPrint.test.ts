/**
 * Budgets P3 PR-E, printed: page 6 of a pack whose company has a budget carries Budget and
 * Variance, eight data columns where it had six. Proven on paper, not on the model: the real
 * print stylesheet, Chromium's PDF and its text layer (`printBoardPack`). Nothing may run past
 * the paper's right edge, the two headings must be on the income statement's sheet, and every
 * budget figure must print whole (a cell too narrow for it wraps the figure across two lines).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { formatStatementFigure, MONEY_SCALES } from '@/lib/format/money';
import { demoInput, demoSet } from '../services/packs/fixtures/boardPackInputs';
import { printBoardPack, type PrintedPack } from './renderPackPdf';

let browser: Browser;
let printed: PrintedPack;
const doc = buildBoardPackPages(demoInput);

beforeAll(async () => {
  browser = await chromium.launch();
  printed = await printBoardPack(doc, browser);
}, 180_000);
afterAll(async () => { await browser?.close(); });

/** The sheet the income statement printed on: the one carrying its rows. */
const incomeSheet = (): string => {
  const sheet = printed.sheetText.find((t) => /Gross profit/.test(t) && /Operating expenses/.test(t) && /Net profit/.test(t));
  if (!sheet) throw new Error('no printed sheet carries the income statement');
  return sheet.replace(/ /g, ' ');
};

describe('page 6 with a budget, on paper', () => {
  it('runs past no page edge', () => {
    expect(printed.overflow).toEqual([]);
  });

  it('heads the two columns on the income statement sheet', () => {
    expect(incomeSheet()).toMatch(/budget/i);
    expect(incomeSheet()).toMatch(/variance/i);
  });

  it('prints every budget figure whole', () => {
    const scale = "R'000" as const;
    expect(MONEY_SCALES[scale]).toBe(1000);
    for (const [key, value] of Object.entries(demoSet.budget!.bands)) {
      const text = formatStatementFigure(value as number, { scale, pack: true }).replace(/ /g, ' ');
      expect(incomeSheet(), `${key} budget ${text}`).toContain(text);
    }
  });
});
