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
 * FOUR PLACES, TWO LAYOUTS. The token goes in the prose, in the approver's own (inherited)
 * action item, and in the derived action panel (a matter's issue text), and each
 * is set in both layouts page 4 can be drawn in. The columns layout is what
 * tells `anywhere` from `break-word`: in a `2fr 1fr` grid a grid item's minimum
 * width is its min-content, `break-word` leaves that at the whole token, and the
 * track grows past the sheet; only `anywhere` lowers it. In the stacked layout
 * (`minmax(0, 1fr)`) the two behave alike, which is why that case alone cannot.
 *
 * Mutation check: delete the rule, drop either selector, or
 * swap `anywhere` for `break-word`, and a case below goes red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { liveDemoShortPanelsInput, manyShortNullQuantumMattersInput } from '../services/packs/fixtures/liveDemoBoardPack';
import { printStylesheet, withChromium } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
// Nothing in the tail is a break opportunity (no `/`, `-`, `&`): a hash-like
// query value, which is what a pasted tracking URL ends in.
const URL_TOKEN = `https://x.co/?id=${'0a1b2c3d4e'.repeat(12)}`.slice(0, 134);

interface Geometry {
  columns: number; scrollWidth: number; bodyRight: number; columnsRight: number;
  panelRight: number; panelItemsRight: number; approvedItemsRight: number; stacked: boolean;
}

async function geometry(input: BoardPackInput): Promise<Geometry> {
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
        const right = (selector: string): number => Math.max(0, ...Array.from(cols.querySelectorAll(selector))
          .map((el) => el.getBoundingClientRect().right));
        return {
          columns: cols.getBoundingClientRect().width, scrollWidth: cols.scrollWidth,
          bodyRight: right('.pack-narrative-body'), columnsRight: cols.getBoundingClientRect().right,
          panelRight: right('.pack-narrative-actions'), panelItemsRight: right('.pack-narrative-actions li'),
          approvedItemsRight: right('.pack-narrative-approved-actions li'),
          stacked: cols.classList.contains('is-stacked'),
        };
      });
    } finally {
      await page.close();
    }
  });
}

/** `base` with the token written into the prose, the approver's action item, or a matter. */
const withToken = (base: BoardPackInput, where: 'prose' | 'action' | 'matter'): BoardPackInput => ({
  ...base,
  matters: where === 'matter'
    ? base.matters.map((m) => ({ ...m, issue: `${m.issue} ${URL_TOKEN}` }))
    : base.matters,
  commentary: {
    status: 'approved',
    body: where === 'prose' ? `Trading held up. See ${URL_TOKEN} for the detail.` : 'Trading held up in the second half.',
    actions: where === 'action' ? [`Review ${URL_TOKEN} before the next meeting.`] : [],
  },
});
const plain = (base: BoardPackInput): BoardPackInput => ({
  ...base, commentary: { status: 'approved', body: 'Trading held up in the second half.', actions: ['Review the schedule.'] },
});

const LAYOUTS: Array<[string, BoardPackInput, boolean]> = [
  ['stacked', liveDemoShortPanelsInput, true],
  ['two columns', manyShortNullQuantumMattersInput, false],
];

describe('page 4 with a long unbroken token in approved commentary', () => {
  it('the token is 134 characters and the layouts are the two the page can draw', async () => {
    expect(URL_TOKEN.length).toBe(134);
    for (const [name, input, stacked] of LAYOUTS) {
      expect((await geometry(plain(input))).stacked, name).toBe(stacked);
    }
  });

  for (const [layout, input] of LAYOUTS) {
    for (const where of ['prose', 'action', 'matter'] as const) {
      it(`keeps a token in the ${where} inside its column — ${layout}`, async () => {
        const base = await geometry(plain(input));
        const long = await geometry(withToken(input, where));
        expect(long.scrollWidth, 'the token pushed the grid wider than its box').toBeLessThanOrEqual(Math.ceil(long.columns));
        // Every item of the three blocks stays inside the sheet's measure.
        for (const edge of [long.bodyRight, long.panelItemsRight, long.approvedItemsRight]) {
          expect(edge).toBeLessThanOrEqual(long.columnsRight + 1);
        }
        // And the panel keeps its place and width.
        expect(Math.abs(long.panelRight - base.panelRight)).toBeLessThanOrEqual(1);
        expect(Math.abs(long.columns - base.columns)).toBeLessThanOrEqual(1);
      });
    }
  }
});
