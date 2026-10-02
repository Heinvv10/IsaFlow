/**
 * THE LEGACY CONTENTS' SPACING DOES NOT LEAK INTO THE BOARD PACK.
 *
 * Both contents blocks carry `data-pack-toc`, so a rule keyed on that attribute
 * reached the board pack's `PackContents` (a `.pack-page` with a fixed
 * min-height) as well. The spacing is keyed on `.pack-legacy-toc`, the legacy
 * view's own class. Read from Chromium's computed style under the real print
 * stylesheet, with the board pack's real element shape, and its sheet height.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { printStylesheet } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

async function measure(css = '') {
  const page = await browser.newPage({ viewport: { width: 660, height: 900 } });
  try {
    await page.setContent('<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
      + `<style>${printStylesheet()}${css}</style></head><body>`
      + '<div id="board"><section data-pack-toc class="pack-page">board contents</section></div>'
      + '<div id="legacy"><section data-pack-toc class="pack-legacy-toc space-y-4">legacy contents</section></div>'
      + '</body></html>');
    await page.emulateMedia({ media: 'print' });
    return await page.evaluate(() => {
      const read = (id: string) => {
        const el = document.querySelector(`#${id} [data-pack-toc]`) as HTMLElement;
        return { marginBottom: getComputedStyle(el).marginBottom, height: el.getBoundingClientRect().height };
      };
      return { board: read('board'), legacy: read('legacy') };
    });
  } finally {
    await page.close();
  }
}

describe('the contents spacing is the legacy view\'s own', () => {
  it('leaves the board pack\'s contents page with no extra margin, and gives the legacy one its gap', async () => {
    const m = await measure();
    expect(m.board.marginBottom).toBe('0px');
    expect(Number.parseFloat(m.legacy.marginBottom)).toBeGreaterThan(30); // 9mm = 34px
  }, 60_000);

  it('does not change the board contents page\'s height (its 255mm sheet)', async () => {
    const withRule = await measure();
    const withoutLegacyRule = await measure('.pack-legacy-toc { margin-bottom: 0 !important; }');
    expect(withRule.board.height).toBe(withoutLegacyRule.board.height);
  }, 60_000);

  it('is red when the rule is keyed on the shared attribute again (mutation)', async () => {
    const m = await measure('html.print-mode [data-pack-toc] { margin-bottom: calc(var(--pack-baseline) * 2); }');
    expect(m.board.marginBottom).not.toBe('0px');
  }, 60_000);
});
