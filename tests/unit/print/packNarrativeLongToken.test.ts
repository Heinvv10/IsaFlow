/**
 * A LONG UNBROKEN TOKEN IN APPROVED COMMENTARY STAYS INSIDE ITS COLUMN.
 *
 * A person can now write the commentary, and a person pastes URLs. `wrappedLines`
 * (the page model) breaks a word wider than the measure inside itself, but
 * Chromium does not unless the CSS says so: a 134-character URL kept its
 * min-content width, pushed page 4's two-column grid wider and the action
 * panel off the sheet — a page the model had measured as fitting. The stylesheet
 * now states `overflow-wrap: anywhere` on the pack's narrative prose, which is
 * what the model assumes. Measured in real Chromium, in the print face.
 *
 * Mutation check: delete the `overflow-wrap` rule and the first test goes red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { liveDemoShortPanelsInput } from '../services/packs/fixtures/liveDemoBoardPack';
import { printStylesheet, withChromium } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
// Nothing in the tail is a break opportunity (no `/`, `-`, `&`): a hash-like
// query value, which is what a pasted tracking URL ends in.
const URL_TOKEN = `https://x.co/?id=${'0a1b2c3d4e'.repeat(12)}`.slice(0, 134);

interface Geometry { columns: number; scrollWidth: number; prose: number; proseRight: number; panelRight: number; panels: number }

async function geometry(body: string): Promise<Geometry> {
  const input: BoardPackInput = { ...liveDemoShortPanelsInput, commentary: { status: 'approved', body, actions: [] } };
  const markup = renderToStaticMarkup(createElement(PackPagesView, { document: buildBoardPackPages(input) }));
  const html = `<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${printStylesheet()}</style></head><body>${markup}</body></html>`;
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
      return await page.evaluate(() => {
        const cols = document.querySelector('.pack-narrative-columns') as HTMLElement;
        const prose = cols.querySelector('.pack-narrative-body') as HTMLElement;
        const panel = cols.querySelector('.pack-narrative-actions') as HTMLElement | null;
        return {
          columns: cols.getBoundingClientRect().width, scrollWidth: cols.scrollWidth,
          prose: prose.getBoundingClientRect().width, proseRight: prose.getBoundingClientRect().right,
          panelRight: panel ? panel.getBoundingClientRect().right : 0,
          panels: panel ? 1 : 0,
        };
      });
    } finally {
      await page.close();
    }
  });
}

describe('page 4 with a long unbroken token in approved commentary', () => {
  it('keeps the token inside the prose column and the columns inside the sheet', async () => {
    const plain = await geometry('Trading held up in the second half. See the supplier schedule for the detail.');
    const long = await geometry(`Trading held up. See ${URL_TOKEN} for the detail.`);
    expect(URL_TOKEN.length).toBe(134);
    expect(long.scrollWidth, 'the token pushed the grid wider than its box').toBeLessThanOrEqual(Math.ceil(long.columns));
    expect(long.proseRight).toBeLessThanOrEqual(plain.proseRight + 1);
    // And the action panel keeps its place and width.
    expect(long.panels).toBe(plain.panels);
    expect(Math.abs(long.panelRight - plain.panelRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(long.prose - plain.prose)).toBeLessThanOrEqual(1);
  });
});
