/**
 * What Chromium laid each statement table of a pack out as: the width of every column, how many lines each row
 * label and the column headings took, and the table's height. The reference `packTableLayout.ts` is held to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser } from 'playwright';
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { PDF_MARGIN_MM } from '@/lib/pdf/pdfTransport';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
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

export async function measureTables(document: PackPagesDocument, browser: Browser): Promise<PrintedTable[]> {
  const body = renderToStaticMarkup(<PackPagesView document={document} />);
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${printStylesheet()}</style></head><body>${body}</body></html>`;
  const page = await browser.newPage({ viewport: { width: PRINT_CONTENT_PX.portrait, height: 1000 } });
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
    // The print lays the page out at PRINT_CONTENT_PX (659px, measured in the PDF).
    await page.evaluate((w) => { document.documentElement.style.width = `${w}px`; }, PRINT_CONTENT_PX.portrait);
    return await page.evaluate((pxMm) => {
      const linesOf = (cell: Element | undefined): number => {
        const text = cell === undefined ? null : Array.from(cell.childNodes).find((n) => n.nodeType === 3);
        if (text === null || text === undefined) return 1;
        const range = document.createRange();
        range.selectNodeContents(text);
        return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
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
    }, PX_PER_MM);
  } finally {
    await page.close();
  }
}
