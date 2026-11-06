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
// A word of nothing but quotes and ellipses, which Chromium breaks between at points the model does not take, is still
// over-refused; a reason is prose, so a word that long has letters.
// The unit of the cycle is a grapheme cluster, so a ZWJ family or a skin-toned hand is never cut in two.
it.each([
  ['\u2019\u00d7\u00e9'], ['\u2014'], ['\u00fc\u00df\u20ac'],
  // Chromium breaks between these, so a run of them wraps (the adversary's probe): refused exactly when it overflows.
  ['\u{1F600}'], ['\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'], ['\u{1F44D}\u{1F3FD}'], ['\u65E5\u672C\u8A9E'], ['\uFF21\uFF22\uFF23'], ['\u20AC'], ['\u2211\u222B'], ['\u2705'], ['\u{1D400}\u{1D401}'], ['\u{11005}\u{11006}'],
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
