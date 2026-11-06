/** ADVERSARIAL REPRO (live on prod fe73d91a2, master and every pack PR): a budget company's page 6 runs
 *  2.7-3.8mm past its sheet and the pack prints 13 sheets. The table's height model reads 73.2mm; Chromium
 *  lays it out at 77.5mm. 45 of 7,301 printed grid packs on prod; 41 on master and #1169. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from '../services/packs/fixtures/advInputs';
import { printBoardPack } from './renderPackPdf';
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });
it('budget company with a loss at R4.2bn revenue prints 12 sheets, page 6 inside its sheet', async () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const doc = buildBoardPackPages(input({ tr: 'demo', budget: true, prior: true, negative: false, loss: true, k: 1000, plug: 0.05, sg: [1, 1, 1, 1] }));
  const out = await printBoardPack(doc, browser);
  expect({ sheets: out.sheets, over: out.heights.filter((h) => h.overMm > 0.2).map((h) => `${h.id}+${h.overMm}`) }).toEqual({ sheets: 12, over: [] });
}, 300_000);
