/**
 * A KPI ROW'S COLUMNS ARE HELD OPEN BY THEIR TILES' WORDS, NOT ONLY THEIR FIGURES.
 *
 * Near the floor a net-debit pack (k = 2.7e8 to 3.2e8) had its page-3 row laid out 2px past the sheet's edge:
 * the "Debt-to-equity" label (56px) held a column open that its 50px figure alone would not.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from '../services/packs/fixtures/packGridInputs';
import { printBoardPack } from './renderPackPdf';
let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
it('net-debit revenue at k=273841963: printed with nothing past the edge, or refused', async () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const doc = buildBoardPackPages(input({ tr: 'demo', budget: false, prior: false, negative: true, loss: false, k: 273_841_963, plug: 0.05, sg: [1, 1, 1, 1] }));
  const out = await printBoardPack(doc, browser);
  expect(out.overflow.map((o) => `${o.id} +${o.over}px ${o.widest}`)).toEqual([]);
}, 300_000);
