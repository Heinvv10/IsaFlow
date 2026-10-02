/**
 * Print the legacy (management) pack's print view to a real PDF in Chromium:
 * the REAL `PackPrintPage`, bundled for the browser, answering only the two
 * `/api` fetches, at the transport's margins.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { printStylesheet } from '../renderPackPdf';
import { PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const ROOT = path.resolve(__dirname, '../../../..');
const HOST = 'http://pack.print.local';

export const DEMO: ReportPackInput = {
  companyName: 'Demo', period: '2026-01-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_123,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
  operatingCashFlow: 345_678, investingCashFlow: -98_765, financingCashFlow: 12_345,
};

export async function printLegacyPack(
  browser: Browser,
  bundle: string,
  input: ReportPackInput,
  opts: { draft?: boolean; extraCss?: string } = {},
): Promise<Buffer> {
  const pack = buildReportPack('management', input, '2026-01-01', '2026-08-31');
  const page = await browser.newPage();
  try {
    await page.route(`${HOST}/**`, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
            + `<style>${printStylesheet()}${opts.extraCss ?? ''}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`,
        });
      }
      if (u.pathname.startsWith('/fonts/')) {
        return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', u.pathname)) });
      }
      if (u.pathname === '/api/accounting/reports-pack') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { pack, draft: opts.draft === true } }) });
      }
      if (u.pathname.startsWith('/api/')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
      }
      return route.abort();
    });
    await page.goto(`${HOST}/?pack=management`, { waitUntil: 'load' });
    await page.waitForSelector('[data-print-ready="true"]', { timeout: 25_000 });
    await page.emulateMedia({ media: 'print' });
    return Buffer.from(await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom), left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right) },
    }));
  } finally {
    await page.close();
  }
}
