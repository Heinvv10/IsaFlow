/**
 * A KPI reason of glyphs outside the basic table (typographic quotes, a multiplication sign, an accented letter) is
 * refused only if Chromium overflows with it: they were charged 14px a glyph, Chromium lays them out at 4 to 9.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { unreadableBlock } from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packScale';
import { input } from '../services/packs/fixtures/packGridInputs';
import { printBoardPack } from './renderPackPdf';
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
// Not covered: a word of nothing but quotes and ellipses, which Chromium breaks between (UAX 14 break opportunities the
// model does not take: it breaks at spaces and after hyphens only). A reason is prose, so a word that long has letters.
it.each([['\u2019\u00d7\u00e9'], ['\u2014'], ['\u00fc\u00df\u20ac']])('a reason run of %s: refused exactly when Chromium overflows, at every length from 20 to 50', async (glyphs) => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const base = buildBoardPackPages(input({ tr: 'demo', budget: false, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [1, 1, 1, 1] }));
  const wrong: string[] = [];
  for (let n = 20; n <= 50; n += 1) {
    const doc = structuredClone(base);
    const p3 = doc.pages.find((p) => p.navLabel === 'Highlights')!;
    const block = p3.blocks.find((b) => b.kind === 'kpiTiles')!;
    if (block.kind !== 'kpiTiles') throw new Error('no tiles');
    const run = Array.from({ length: n }, (unused, i) => [...glyphs][i % [...glyphs].length]).join('');
    block.tiles[3]!.figure = { ...block.tiles[3]!.figure, value: null, unavailable: `Not ${run} here.` };
    const out = await printBoardPack(doc, browser);
    const overflows = out.overflow.some((o) => o.id === `pack-page-${doc.pages.indexOf(p3) + 1}`);
    const refused = unreadableBlock(p3, PACK_SCALE) !== null;
    if (refused !== overflows) wrong.push(`${n} glyphs: refused ${refused}, Chromium overflows ${overflows}`);
  }
  expect(wrong).toEqual([]);
}, 600_000);
