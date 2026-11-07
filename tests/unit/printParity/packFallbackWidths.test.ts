/**
 * THE COMMITTED FALLBACK WIDTHS ARE THE PRODUCTION IMAGE'S: measured afresh in a throwaway container of the image
 * production's Gotenberg runs, the tables `packFallbackWidthData.ts` holds come out the same, character for character
 * (`fallbackWidths.ts` says how they are measured). With REGENERATE_FALLBACK_WIDTHS=1 it writes them instead. Velo only
 * (the image is there); elsewhere skipped, and says why: there the fallback glyphs are the render-time guard's.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureAdvances, measureEmojiAndFingerprint } from './fallbackWidths';
import { fallbackWidthSource } from './fallbackWidthSource';
import { PRODUCTION_GOTENBERG_IMAGE, parityUnavailable, startGotenberg, type Gotenberg } from './gotenbergParity';

const TARGET = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packFallbackWidthData.ts');
const unavailable = parityUnavailable();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`the fallback widths of production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it(process.env.REGENERATE_FALLBACK_WIDTHS === '1' ? 'writes packFallbackWidthData.ts' : 'the committed tables are what the image measures now', async () => {
    const advances = await measureAdvances(gotenberg!);
    const { emoji, fingerprint } = await measureEmojiAndFingerprint(gotenberg!);
    const source = fallbackWidthSource(advances, emoji, fingerprint, `gotenberg/gotenberg:8 (${PRODUCTION_GOTENBERG_IMAGE.slice(0, 19)})`);
    if (process.env.REGENERATE_FALLBACK_WIDTHS === '1') writeFileSync(TARGET, source);
    else expect(readFileSync(TARGET, 'utf8') === source, 'packFallbackWidthData.ts differs from the image; regenerate it').toBe(true);
  }, 3_600_000);
});
