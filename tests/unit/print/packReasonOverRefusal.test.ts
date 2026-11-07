/**
 * A KPI reason set in the pack's own face is refused EXACTLY when Chromium overflows with it, at every length: typographic
 * quotes, a multiplication sign, accented letters, an em dash, the euro, and figures grouped with no-break spaces (the
 * adversary's round 3: "123 123 ..." with NBSPs passed the gate and overflowed by 27px or more, because the model broke
 * at the no-break space and Chromium does not). A reason of glyphs outside the face is priced from production's image
 * and held there (`tests/unit/printParity/packReasonFallbackGate.test.ts`, on velo).
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { unreadableBlock } from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packScale';
import { input } from '../services/packs/fixtures/packGridInputs';
import { printBoardPack } from './renderPackPdf';
let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
// A word of nothing but quotes and ellipses, which Chromium breaks between at points the model does not take, is still
// over-refused; a reason is prose, so a word that long has letters.
it.each([
  ['\u2019\u00d7\u00e9'], ['\u2014'], ['\u00fc\u00df\u20ac'], ['123\u00a0'], ['R\u00a01\u202f000 '],
])('a reason run of %s: refused exactly when Chromium overflows, at every length from 4 to 50', async (glyphs) => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const base = buildBoardPackPages(input({ tr: 'demo', budget: false, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [1, 1, 1, 1] }));
  const wrong: string[] = [];
  const cycle = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(glyphs), (part) => part.segment);
  for (let n = 4; n <= 50; n += 1) {
    const doc = structuredClone(base);
    const p3 = doc.pages.find((p) => p.navLabel === 'Highlights')!;
    const block = p3.blocks.find((b) => b.kind === 'kpiTiles')!;
    if (block.kind !== 'kpiTiles') throw new Error('no tiles');
    const run = Array.from({ length: n }, (unused, i) => cycle[i % cycle.length]).join('');
    block.tiles[3]!.figure = { ...block.tiles[3]!.figure, value: null, unavailable: `Not ${run} here.` };
    const out = await printBoardPack(doc, browser);
    const overflows = out.overflow.some((o) => o.id === `pack-page-${doc.pages.indexOf(p3) + 1}`);
    const refused = unreadableBlock(p3, PACK_SCALE) !== null;
    if (refused !== overflows) wrong.push(`${n} glyphs: refused ${refused}, Chromium overflows ${overflows}`);
  }
  expect(wrong).toEqual([]);
}, 600_000);
