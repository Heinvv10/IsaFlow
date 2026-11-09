/**
 * A NOT-MEANINGFUL REASON IS SET IN THE REGULAR FACE, SLANTED: THE FACE `packKpiLayout` CHECKS ITS TEXT AGAINST.
 *
 * `.pack-kpi-unavailable` is `font-style: italic`, and the pack declares no italic face: every `IBM Plex Sans`
 * `@font-face` in its stylesheet is `normal`, so Chromium slants the regular one (`packReasonWidth.ts` prices its
 * advances from that face). So the code points the 400 face sets are exactly the ones a reason can be set in, which is
 * what `packKpiLayout.inPackFaces` checks. Held here twice: the stylesheet declares no italic Plex face, and Chromium,
 * asked which fonts it set a reason in (`CSS.getPlatformFontsForNode`), names the pack's face alone for the pack's own
 * wording and adds a fallback face for a script the face lacks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { printStylesheet } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

it('the pack declares no italic IBM Plex Sans face', () => {
  const faces = printStylesheet().match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const plex = faces.filter((f) => /font-family:\s*['"]IBM Plex Sans['"]/.test(f));
  expect(plex.length).toBeGreaterThanOrEqual(3);
  expect(plex.filter((f) => !/font-style:\s*normal/.test(f))).toEqual([]);
});

it('Chromium sets a reason in the pack\'s face alone, and reaches a fallback face only for a script the face lacks', async () => {
  const reasons = ['Revenue is not positive, so there is no turnover to take a margin of.', 'รายได้'];
  const body = `<div class="pack-pages"><div class="pack-page">${reasons.map((r, i) => `<div class="pack-kpi-tile"><span class="pack-kpi-unavailable" id="r${i}">${r}</span></div>`).join('')}</div></div>`;
  const html = `<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${printStylesheet()}</style></head><body>${body}</body></html>`;
  const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
  try {
    await page.route(`${HOST}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      if (url.pathname.startsWith('/fonts/')) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', url.pathname)) });
      return route.abort();
    });
    await page.goto(HOST, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => { await document.fonts.ready; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const fontsOf = async (id: string): Promise<string[]> => {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      return fonts.map((f) => f.familyName);
    };
    expect(await fontsOf('r0')).toEqual(['IBM Plex Sans']);
    expect((await fontsOf('r1')).some((f) => f !== 'IBM Plex Sans'), 'Thai reaches a fallback face').toBe(true);
  } finally {
    await page.close();
  }
}, 120_000);
