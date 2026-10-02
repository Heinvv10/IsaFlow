/**
 * A PAGE-10 PANEL'S TITLE KEEPS TO THREE LINES, AS CHROMIUM SETS IT.
 *
 * The long-window pack's Net profit panel ran its title to four lines; the
 * last sat on the panel's top tick ("1 908") and set that plot lower than its
 * neighbour's. Measured in the print face, on the fixtures whose net profit
 * panel carries the scale-setting month and the part month — the longest
 * titles the page draws.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { liveDemoInput, liveDemoRenderedInput, millionsCashInput } from '../services/packs/fixtures/liveDemoBoardPack';
import { printStylesheet, withChromium } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
const LINE_PX = (12 * 96) / 72;

async function titleLines(input: BoardPackInput): Promise<Array<{ title: string; lines: number }>> {
  const body = renderToStaticMarkup(createElement(PackPagesView, { document: buildBoardPackPages(input) }));
  const html = `<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${printStylesheet()}</style></head><body>${body}</body></html>`;
  return withChromium(async (browser) => {
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
      return await page.$$eval('.pack-small-multiples .pack-chart-title', (titles, line) => titles.map((t) => ({
        title: t.textContent ?? '', lines: Math.round(t.getBoundingClientRect().height / line),
      })), LINE_PX);
    } finally {
      await page.close();
    }
  });
}

describe('page 10\'s panel titles', () => {
  it.each([
    ['the live demo company as it renders', liveDemoRenderedInput],
    ['the live demo company', liveDemoInput],
    ['cash in the millions', millionsCashInput],
  ])('keep to three lines — %s', async (_name, input) => {
    const titles = await titleLines(input);
    expect(titles.length).toBeGreaterThan(3);
    expect(titles.filter((t) => t.lines > 3).map((t) => `${t.lines}: ${t.title}`)).toEqual([]);
  });
});
