/**
 * THE CONTENTS LIST'S TITLES START IN ONE COLUMN.
 *
 * Page 2 prints the twelve sheets' numbers before their titles, and the
 * number took only its own width: "10", "11" and "12" pushed their titles
 * further right than "1" to "9" did, so the last three rows of the index
 * read as indented, as if they were sub-entries. Measured in Chromium, with
 * the pack's own stylesheets and faces.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from '../services/packs/fixtures/boardPackInputs';
import { printStylesheet, withChromium } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';

describe('the contents list', () => {
  it('starts every title at the same x, one digit or two', async () => {
    const body = renderToStaticMarkup(createElement(PackPagesView, { document: buildBoardPackPages(demoInput) }));
    const html = `<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${printStylesheet()}</style></head><body>${body}</body></html>`;
    const lefts = await withChromium(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 658, height: 900 } });
      try {
        await page.route(`${HOST}**`, async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
          if (url.pathname.startsWith('/fonts/')) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', url.pathname)) });
          return route.abort();
        });
        await page.goto(HOST, { waitUntil: 'load' });
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(() => document.fonts.ready);
        return await page.$$eval('.pack-contents-item', (items) => items.map((item) => ({
          number: item.querySelector('.pack-contents-number')?.textContent ?? '',
          left: item.querySelector('.pack-contents-title')!.getBoundingClientRect().left,
        })));
      } finally {
        await page.close();
      }
    });
    expect(lefts.length).toBe(12);
    expect(lefts.some((l) => l.number.length === 2)).toBe(true);
    const xs = lefts.map((l) => Math.round(l.left * 10) / 10);
    expect(new Set(xs).size, lefts.map((l) => `${l.number}@${l.left.toFixed(1)}`).join(' ')).toBe(1);
  });
});
