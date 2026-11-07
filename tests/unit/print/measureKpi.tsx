/**
 * What Chromium laid each KPI tile row of a pack out as: its four column widths, each row of tiles' height and the
 * block's height. The reference `packKpiLayout.ts` is held to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser } from 'playwright';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { PDF_MARGIN_MM } from '@/lib/pdf/pdfTransport';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { printStylesheet } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
const PX_PER_MM = 96 / 25.4;

export interface PrintedKpiBlock {
  /** The page it is on (`PackPage.number`). */
  page: number;
  /** The four column widths, in pixels (the grid's computed tracks). */
  columnsPx: number[];
  /** The height of each row of tiles (a tile stretches to its row), in mm. */
  rowsMm: number[];
  /** The block's own height, in mm. */
  heightMm: number;
}

export async function measureKpiBlocks(document: PackPagesDocument, browser: Browser): Promise<PrintedKpiBlock[]> {
  const body = renderToStaticMarkup(<PackPagesView document={document} />);
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${printStylesheet()}</style></head><body>${body}</body></html>`;
  const page = await browser.newPage({ viewport: { width: Math.round((210 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right) * PX_PER_MM), height: 1000 } });
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
    // The print lays the page out at 174mm = 657.6px; the viewport is a whole 658. Measure at the print's width.
    await page.evaluate(() => { document.documentElement.style.width = '657.6px'; });
    return await page.evaluate((pxMm) => Array.from(document.querySelectorAll('.pack-kpi-tiles')).map((row) => {
      const tiles = Array.from(row.children);
      const tops = [...new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().top)))];
      return {
        page: Number((row.closest('.pack-page')?.id ?? '').replace('pack-page-', '')),
        columnsPx: getComputedStyle(row).gridTemplateColumns.split(' ').map((c) => parseFloat(c)),
        rowsMm: tops.map((top) => tiles.find((t) => Math.round(t.getBoundingClientRect().top) === top)!.getBoundingClientRect().height / pxMm),
        heightMm: row.getBoundingClientRect().height / pxMm,
      };
    }), PX_PER_MM);
  } finally {
    await page.close();
  }
}
