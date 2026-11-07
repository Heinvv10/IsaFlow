/**
 * THE RENDER-TIME FALLBACK GUARD, IN A REAL BROWSER (`packFallbackGuard.ts`, bundled as the print page bundles it).
 *
 * A pack set wholly in the self-hosted faces never takes the measurement and may print anywhere. A pack whose KPI
 * reason holds a glyph outside them is checked: on this host (Playwright's Chromium with the machine's fonts, not
 * production's image) the guard measures the fingerprint, and refuses exactly when it differs from the committed one.
 * In production's image it passes (`tests/unit/printParity/packFallbackGuardImage.test.ts`, on velo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { FALLBACK } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { input } from '../services/packs/fixtures/packGridInputs';
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';
import { launchPrintChromium } from './printChromium';
import { openProbePage } from './measureWidths';
import { bundlePrintPages } from './support/bundlePrintPages';

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  browser = await launchPrintChromium();
  bundle = await bundlePrintPages(path.join(__dirname, 'support/fallbackGuardEntry.ts'));
}, 180_000);
afterAll(async () => { await browser?.close(); });

function packWithReason(reason: string | null): PackPagesDocument {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  try {
    const doc = buildBoardPackPages(input({ tr: 'demo', budget: false, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [1, 1, 1, 1] }));
    if (reason === null) return doc;
    const block = doc.pages.find((p) => p.navLabel === 'Highlights')!.blocks.find((b) => b.kind === 'kpiTiles')!;
    if (block.kind !== 'kpiTiles') throw new Error('no tiles');
    block.tiles[3]!.figure = { ...block.tiles[3]!.figure, value: null, unavailable: reason };
    return stampFigureFits(doc);
  } finally {
    warn.mockRestore();
  }
}

type Guard = { fallbackFontsVerdict(d: Document): string | null; usesFallbackGlyphs(d: Document): boolean; measureFingerprint(d: Document): Record<string, number[]> };

async function verdictOf(doc: PackPagesDocument): Promise<{ uses: boolean; verdict: string | null; fingerprint: Record<string, number[]> }> {
  const page = await openProbePage(browser);
  try {
    await page.evaluate((markup) => { document.body.insertAdjacentHTML('beforeend', markup); }, renderToStaticMarkup(createElement(PackPagesView, { document: doc })));
    await page.addScriptTag({ content: bundle });
    return await page.evaluate(() => {
      const guard = (window as unknown as { PrintPages: Guard }).PrintPages;
      return { uses: guard.usesFallbackGlyphs(document), verdict: guard.fallbackFontsVerdict(document), fingerprint: guard.measureFingerprint(document) };
    });
  } finally {
    await page.close();
  }
}

describe('the fallback guard', () => {
  it('a pack in the self-hosted faces only: nothing to check, it may print', async () => {
    const res = await verdictOf(packWithReason('Revenue is not positive, so 12% cannot be measured.'));
    expect(res.uses).toBe(false);
    expect(res.verdict).toBeNull();
  }, 120_000);

  it('a reason with an emoji: the guard measures, and refuses exactly when this host\'s fingerprint is not the committed one', async () => {
    const res = await verdictOf(packWithReason('Not ℹ️ here.'));
    expect(res.uses).toBe(true);
    const same = Object.entries(res.fingerprint).every(([style, widths]) => JSON.stringify(widths) === JSON.stringify(FALLBACK[style as keyof typeof FALLBACK].fingerprint));
    expect(res.verdict === null, `this host's fingerprint ${same ? 'is' : 'is not'} production's`).toBe(same);
    if (!same) expect(res.verdict).toContain('fallback fonts are not production');
  }, 120_000);
});
