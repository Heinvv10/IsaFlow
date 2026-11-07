/**
 * IN PRODUCTION'S IMAGE THE FALLBACK GUARD LETS A PACK PRINT: a pack whose KPI reason holds an emoji is laid out in a
 * throwaway Gotenberg of the image, the bundled guard (`packFallbackGuard.ts`) re-measures the fingerprint there, and
 * finds it is the committed one. (Change one committed fingerprint width and this goes red: the guard refuses.) Velo
 * only; elsewhere skipped, and says why.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from '../services/packs/fixtures/packGridInputs';
import { bundlePrintPages } from '../print/support/bundlePrintPages';
import { gotenbergPdf, parityUnavailable, startGotenberg, withPdfFile, type Gotenberg } from './gotenbergParity';
import { parityDocument } from './parityPage';

const unavailable = parityUnavailable();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

const RUN = `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  var verdict = window.PrintPages.fallbackFontsVerdict(document);
  var uses = window.PrintPages.usesFallbackGlyphs(document);
  document.body.innerHTML = '';
  var pre = document.createElement('pre');
  pre.style.cssText = 'font:7px monospace;white-space:pre-wrap;margin:0';
  pre.textContent = 'V|' + uses + '|' + (verdict === null ? 'null' : verdict);
  document.body.appendChild(pre);
  window.parityDone = true;
})();`;

describe.skipIf(unavailable !== null)(`the fallback guard in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('a reason with an emoji: the image\'s fingerprint is the committed one, so the pack may print', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const doc = buildBoardPackPages(input({ tr: 'demo', budget: false, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [1, 1, 1, 1] }));
    const block = doc.pages.find((p) => p.navLabel === 'Highlights')!.blocks.find((b) => b.kind === 'kpiTiles')!;
    if (block.kind !== 'kpiTiles') throw new Error('no tiles');
    block.tiles[3]!.figure = { ...block.tiles[3]!.figure, value: null, unavailable: 'Not ℹ️ here.' };
    const bundle = (await bundlePrintPages(path.join(__dirname, '../print/support/fallbackGuardEntry.ts'))).replace(/<\/script/gi, '<\\/script');
    const { html, fonts } = parityDocument(renderToStaticMarkup(createElement(PackPagesView, { document: doc })));
    const page = html.replace(/<script>[\s\S]*<\/script>/, () => `<script>${bundle}</script><script>${RUN}</script>`);
    const text = withPdfFile(await gotenbergPdf(gotenberg!, page, fonts, 'window.parityDone === true'),
      (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8' }));
    const line = text.split('\n').find((l) => l.startsWith('V|'))?.trim();
    expect(line).toBe('V|true|null');
  }, 300_000);
});
