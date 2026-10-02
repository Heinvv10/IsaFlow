/**
 * A COMPOSED TITLE DOES NOT BREAK INSIDE A HYPHENATED COMPOUND.
 *
 * Chromium broke Brightsphere's highlights title at "non-|positive" and the
 * long-window trends title at "12-|month": a line ending on a hyphen, its
 * word finished on the next. Measured as Chromium sets the titles, in the
 * print face: no line of a page title or a chart title ends on a hyphen.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from '../services/packs/fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput } from '../services/packs/fixtures/liveDemoBoardPack';
import { printStylesheet, withChromium } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';

/** Every line break in a title that falls just after a hyphen, as text. */
async function hyphenBreaks(input: BoardPackInput): Promise<{ titles: number; hyphenated: number; breaks: string[] }> {
  const body = renderToStaticMarkup(createElement(PackPagesView, { document: buildBoardPackPages(input) }));
  const html = `<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${printStylesheet()}</style></head><body>${body}</body></html>`;
  return withChromium(async (browser) => {
    // The 174mm portrait measure the PDF sets the sheet in.
    const page = await browser.newPage({ viewport: { width: 658, height: 1123 } });
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
      return await page.$$eval('.pack-title, .pack-chart-title', (titles) => {
        const breaks: string[] = [];
        let hyphenated = 0;
        for (const title of titles) {
          const text = title.textContent ?? '';
          if (/\w[-‐‑]\w/.test(text)) hyphenated += 1;
          const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
          const chars: Array<{ ch: string; top: number }> = [];
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            for (let i = 0; i < (node.textContent ?? '').length; i += 1) {
              const range = document.createRange();
              range.setStart(node, i);
              range.setEnd(node, i + 1);
              const rect = range.getClientRects()[0];
              if (rect !== undefined) chars.push({ ch: node.textContent![i]!, top: rect.top });
            }
          }
          for (let i = 0; i + 1 < chars.length; i += 1) {
            if (chars[i + 1]!.top > chars[i]!.top + 4 && /[-‐‑]/.test(chars[i]!.ch)) {
              breaks.push(`"${text.slice(0, 60)}…" breaks after "${chars.slice(Math.max(0, i - 4), i + 1).map((c) => c.ch).join('')}"`);
            }
          }
        }
        return { titles: titles.length, hyphenated, breaks };
      });
    } finally {
      await page.close();
    }
  });
}

describe('a composed title keeps a hyphenated compound on one line', () => {
  it.each([
    ['Brightsphere: "non-positive"', brightsphereLiveInput],
    ['the long-window pack: "12-month"', liveDemoInput],
    ['the live demo company as it renders', liveDemoRenderedInput],
  ])('%s', async (_name, input) => {
    const found = await hyphenBreaks(input);
    expect(found.hyphenated, 'no title carries a hyphenated compound, so nothing is under test').toBeGreaterThan(0);
    expect(found.breaks).toEqual([]);
  });
});
