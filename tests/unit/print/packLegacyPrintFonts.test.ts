/**
 * THE LEGACY (MANAGEMENT) PRINT VIEW EMBEDS ONLY THE PACK'S OWN FACE.
 *
 * It reuses screen components — statement rows, KPI tiles — whose figures are
 * set in `var(--ff-fig-font)`, IBM Plex Mono, which the print page does not
 * load. Chromium substituted DejaVuSansMono, and the printed management pack
 * carried a fallback typeface in every figure column. The board pack is held
 * to one face by `packOneTypeface.test.ts`; this holds the other print view.
 *
 * The REAL `PackPrintPage` is bundled for the browser, mounted in Chromium with
 * the print stylesheet, printed through `page.pdf`, and `pdffonts` reads which
 * faces the file embeds.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { bundlePrintPages } from './support/bundlePrintPages';
import { printStylesheet } from './renderPackPdf';
import { PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local';

const DEMO: ReportPackInput = {
  companyName: 'Demo', period: '2026-01-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_123,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
  operatingCashFlow: 345_678, investingCashFlow: -98_765, financingCashFlow: 12_345,
};
/** Negative revenue and equity, a loss, no cash flow read: Brightsphere's shape. */
const BRIGHTSPHERE_SHAPED: ReportPackInput = {
  ...DEMO, companyName: 'Brightsphere', revenue: -5_535_000, costOfSales: 0, operatingExpenses: 3_717_000,
  netProfit: -1_407_763, totalEquity: -1_300_000, totalAssets: 700_000, totalLiabilities: 2_000_000,
  cash: -530_836, operatingCashFlow: undefined, investingCashFlow: undefined, financingCashFlow: undefined,
};

let browser: Browser;
let bundle: string;
let dir: string;
beforeAll(async () => {
  bundle = await bundlePrintPages();
  browser = await chromium.launch();
  dir = mkdtempSync(path.join(tmpdir(), 'pack-fonts-'));
}, 180_000);
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The faces the printed management pack embeds, one name per line. */
async function embeddedFaces(input: ReportPackInput, tag: string, extraCss = ''): Promise<string[]> {
  const pack = buildReportPack('management', input, '2026-01-01', '2026-08-31');
  const page = await browser.newPage();
  try {
    await page.route(`${HOST}/**`, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
            + `<style>${printStylesheet()}${extraCss}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`,
        });
      }
      if (u.pathname.startsWith('/fonts/')) {
        return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', u.pathname)) });
      }
      if (u.pathname === '/api/accounting/reports-pack') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { pack } }) });
      }
      if (u.pathname.startsWith('/api/')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
      }
      return route.abort();
    });
    await page.goto(`${HOST}/?pack=management`, { waitUntil: 'load' });
    await page.waitForSelector('[data-print-ready="true"]', { timeout: 25_000 });
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom), left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right) },
    });
    const file = path.join(dir, `${tag}.pdf`);
    writeFileSync(file, pdf);
    const { stdout } = await run('pdffonts', [file]);
    return stdout.split('\n').slice(2).map((l) => l.trim().split(/\s+/)[0] ?? '').filter(Boolean);
  } finally {
    await page.close();
  }
}

const stripSubset = (name: string) => name.replace(/^[A-Z]{6}\+/, '');

describe('the printed management pack embeds only IBM Plex Sans', () => {
  it.each([
    ['the composed demo', DEMO],
    ['a Brightsphere-shaped pack', BRIGHTSPHERE_SHAPED],
  ] as const)('%s', async (name, input) => {
    const faces = await embeddedFaces(input, name.replace(/\W+/g, '_'));
    expect(faces.length, 'no font was embedded at all').toBeGreaterThan(0);
    expect(faces.map(stripSubset).filter((f) => !f.startsWith('IBMPlexSans'))).toEqual([]);
  }, 90_000);

  it('is red when a figure is set in the screen monospace again (mutation)', async () => {
    const faces = await embeddedFaces(DEMO, 'mutant',
      'html.print-mode { --ff-fig-font: "IBM Plex Mono", ui-monospace, monospace; }');
    expect(faces.map(stripSubset).filter((f) => !f.startsWith('IBMPlexSans')).length).toBeGreaterThan(0);
  }, 90_000);
});
