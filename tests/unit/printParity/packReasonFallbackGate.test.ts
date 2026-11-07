/**
 * A KPI REASON OF GLYPHS OUTSIDE THE PACK'S OWN FACE NEVER PASSES THE GATE AND RUNS OFF THE SHEET IN PRODUCTION'S IMAGE.
 *
 * Emoji (with VS16, keycaps, ZWJ families, skin tones), ideographs, full-width forms, mathematical letters and an
 * ancient script, each cycled into a reason of every length from 4 to 50 clusters: wherever the gate passes the row,
 * the image lays the page out inside the sheet (`gotenbergOverflow.ts`). These glyphs are priced at their block's
 * widest, so a refusal of a row that would have fitted is allowed; a pass that overflows is not. The adversary's round 3
 * found ℹ️, ♥️ and ®️ passing and overflowing by up to 237px. Velo only; elsewhere skipped, and says why.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { unreadableBlock } from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packScale';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { input } from '../services/packs/fixtures/packGridInputs';
import { gotenbergOverflow } from './gotenbergOverflow';
import { parityUnavailable, startGotenberg, type Gotenberg } from './gotenbergParity';

const unavailable = parityUnavailable();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });
afterEach(() => { vi.restoreAllMocks(); });

const CYCLES = ['ℹ️', '♥️', '®️', '1️⃣', '❤️', '\u{1F600}', '\u{1F468}‍\u{1F469}‍\u{1F467}',
  '\u{1F44D}\u{1F3FD}', '日本語', 'ＡＢＣ', '✅', '\u{1D400}\u{1D401}', '\u{11005}\u{11006}', '\u{1F1FF}\u{1F1E6}'];

describe.skipIf(unavailable !== null)(`reasons of fallback glyphs in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it.each(CYCLES)('a reason run of %s: never passed where the image overflows, at every length from 4 to 50', async (glyphs) => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const base = buildBoardPackPages(input({ tr: 'demo', budget: false, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [1, 1, 1, 1] }));
    const cycle = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(glyphs), (part) => part.segment);
    const docs: PackPagesDocument[] = [];
    const refused: boolean[] = [];
    for (let n = 4; n <= 50; n += 1) {
      const doc = structuredClone(base);
      const p3 = doc.pages.find((p) => p.navLabel === 'Highlights')!;
      const block = p3.blocks.find((b) => b.kind === 'kpiTiles')!;
      if (block.kind !== 'kpiTiles') throw new Error('no tiles');
      const run = Array.from({ length: n }, (unused, i) => cycle[i % cycle.length]).join('');
      block.tiles[3]!.figure = { ...block.tiles[3]!.figure, value: null, unavailable: `Not ${run} here.` };
      docs.push(doc);
      refused.push(unreadableBlock(p3, PACK_SCALE) !== null);
    }
    const overflow = await gotenbergOverflow(gotenberg!, docs);
    const passedOverflowing = docs.flatMap((doc, i) => {
      const id = `pack-page-${doc.pages.findIndex((p) => p.navLabel === 'Highlights') + 1}`;
      return !refused[i] && overflow[i]!.includes(id) ? [`${i + 4} clusters`] : [];
    });
    expect(refused.some((r) => !r), 'the short runs pass').toBe(true);
    expect(passedOverflowing).toEqual([]);
  }, 600_000);
});
