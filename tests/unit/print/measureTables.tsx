/**
 * What Chromium laid each statement table of a pack out as: the width of every column, how many lines each row
 * label and the column headings took, and the table's height. The reference `packTableLayout.ts` is held to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser } from 'playwright';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { PRINT_CONTENT_PX, type PageOrientation } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { printStylesheet } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
const PX_PER_MM = 96 / 25.4;

export interface PrintedTable {
  /** The page it is on (`PackPage.number`); a page's tables are in document order. */
  page: number;
  /** The label column's width then each data column's. */
  columnsPx: number[];
  /** Lines of each body row's label. */
  labelLines: number[];
  /** The most lines any heading took. */
  headingLines: number;
  /** The caption's, the heading row's and each body row's height, with the row's role class. */
  captionMm: number;
  headMm: number;
  rowsMm: Array<{ role: string; mm: number }>;
  /** The `table` element's own height (its caption included, the reasons list under it not). */
  heightMm: number;
}

/**
 * A page script: `tablesOf(pxPerMm)`, each statement table of the page as a `PrintedTable`. Run in the print tests'
 * Chromium (`measureTables`) and in production's image (`printParity/packBreakPairsImage.test.ts`).
 */
export const TABLES_OF = `function tablesOf(pxMm) {
  const linesOf = (cell) => {
    // A label printed to break anywhere sits in its own block (\`pack-label-anywhere\`), its text and mark inside.
    const host = cell === undefined ? undefined : (cell.querySelector('.pack-label-anywhere') || cell);
    const text = host === undefined ? null : Array.from(host.childNodes).find((n) => n.nodeType === 3);
    if (text === null || text === undefined) return 1;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = Array.from(range.getClientRects());
    // A footnote mark Chromium broke before sits on a line of its own: its superscript below the words' last line.
    const sup = cell.querySelector('sup');
    const alone = sup !== null && rects.length > 0 && sup.getBoundingClientRect().bottom > rects[rects.length - 1].bottom + 4;
    return new Set(rects.map((r) => Math.round(r.top))).size + (alone ? 1 : 0);
  };
  return Array.from(document.querySelectorAll('table.pack-table:not(.pack-matters):not(.pack-scorecard-group):not(.pack-definition-bridge)')).map((table) => {
    const head = Array.from(table.querySelectorAll('thead tr:first-child th'));
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const owner = table.closest('.pack-page');
    return {
      page: Number((owner?.id ?? '').replace('pack-page-', '')),
      columnsPx: head.map((c) => c.getBoundingClientRect().width),
      labelLines: rows.map((r) => linesOf(r.children[0])),
      headingLines: Math.max(1, ...head.map((c) => linesOf(c))),
      captionMm: (table.querySelector('caption')?.getBoundingClientRect().height ?? 0) / pxMm,
      headMm: (table.querySelector('thead tr')?.getBoundingClientRect().height ?? 0) / pxMm,
      rowsMm: rows.map((r) => ({ role: r.className || 'line', mm: r.getBoundingClientRect().height / pxMm })),
      heightMm: table.getBoundingClientRect().height / pxMm,
    };
  });
}`;

/** `orientation`: the width every page is laid out at (a landscape page's tables are measured at the landscape width). */
export async function measureTables(document: PackPagesDocument, browser: Browser, orientation: PageOrientation = 'portrait'): Promise<PrintedTable[]> {
  const body = renderToStaticMarkup(<PackPagesView document={document} />);
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${printStylesheet()}</style></head><body>${body}</body></html>`;
  const page = await browser.newPage({ viewport: { width: Math.ceil(PRINT_CONTENT_PX[orientation]) + 1, height: 1000 } });
  try {
    await page.route(`${HOST}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      if (url.pathname.startsWith('/fonts/')) {
        return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', url.pathname)) });
      }
      return route.abort();
    });
    await page.goto(HOST, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => {
      await Promise.all([400, 500, 600].map((w) => document.fonts.load(`${w} 16px "IBM Plex Sans"`)));
      await document.fonts.ready;
    });
    // Production prints a page's content PRINT_CONTENT_PX wide (658px portrait, 987px landscape, measured in its
    // Gotenberg image; not 174mm = 657.6). A viewport is whole pixels, so the root is set to it inside one a pixel wider.
    await page.evaluate((w) => { document.documentElement.style.width = `${w}px`; }, PRINT_CONTENT_PX[orientation]);
    return await page.evaluate(`(function () { ${TABLES_OF}; return tablesOf(${PX_PER_MM}); })()`) as PrintedTable[];
  } finally {
    await page.close();
  }
}
