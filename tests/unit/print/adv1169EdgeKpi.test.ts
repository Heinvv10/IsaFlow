/** ADVERSARIAL REPRO (#1169 9cb2509c2): at the KPI floor the gate passes a page-3 row that Chromium lays
 *  out 2px past the sheet's edge (8 net-debit packs at k = 2.7e8 - 3.2e8 in the near-floor sample). */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from '../services/packs/fixtures/advInputs';
import { printBoardPack } from './renderPackPdf';
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });
it('net-debit revenue at k=273841963: printed with nothing past the edge, or refused', async () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const doc = buildBoardPackPages(input({ tr: 'demo', budget: false, prior: false, negative: true, loss: false, k: 273_841_963, plug: 0.05, sg: [1, 1, 1, 1] }));
  const out = await printBoardPack(doc, browser);
  expect(out.overflow.map((o) => `${o.id} +${o.over}px ${o.widest}`)).toEqual([]);
}, 300_000);
