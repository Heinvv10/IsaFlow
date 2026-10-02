/**
 * A HEALTHY PRINT PAGE RAISES NOTHING — NOT AN UNCAUGHT ERROR, NOT AN
 * UNHANDLED REJECTION, NOT A CONSOLE ERROR.
 *
 * That has to hold for two reasons. Production prints through Gotenberg, and
 * the day anyone points `failOnConsoleExceptions` at it a single stray
 * exception on the page fails every pack PDF. And `markPrintError` raises an
 * uncaught error on purpose when a page can never print, so any OTHER one
 * makes a real failure indistinguishable from noise.
 *
 * The REAL components (`PackPagesPrintPage`, `PackPrintPage`) are bundled for
 * the browser with Vite and mounted in Chromium; only the two `/api` fetches
 * are answered, with the board pack composed from the fixtures and the
 * management pack from the real service. The page is watched from
 * navigation until it says `data-print-ready="true"`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { bundlePrintPages } from './support/bundlePrintPages';
import { printStylesheet } from './renderPackPdf';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { serialisePackPagesDocument } from '@/modules/accounting/services/packs/pages/packDocumentWire';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { brightsphereInput, demoInput } from '../services/packs/fixtures/boardPackInputs';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local';

const MANAGEMENT_INPUT: ReportPackInput = {
  companyName: 'Demo', period: '2026-01-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_123,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
};

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await bundlePrintPages();
  browser = await chromium.launch();
}, 180_000);
afterAll(async () => { await browser?.close(); });

interface Quiet { errors: string[]; ready: boolean }

/** Load a print page and collect everything it raises until it is print-ready
 *  (or fails to become so within the budget). */
async function load(url: string, answer: (pathname: string) => unknown, mutate?: string): Promise<Quiet> {
  const page: Page = await browser.newPage({ viewport: { width: 660, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!r.url().includes('/fonts/')) errors.push(`requestfailed: ${r.url()}`); });
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (e) => {
      console.error(`unhandledrejection: ${String((e.reason as Error | undefined)?.message ?? e.reason)}`);
    });
  });
  try {
    await page.route(`${HOST}/**`, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
            + `<style>${printStylesheet()}</style></head><body><div id="root"></div>`
            + `<script>${bundle}</script>${mutate ? `<script>${mutate}</script>` : ''}</body></html>`,
        });
      }
      if (u.pathname.startsWith('/fonts/')) {
        return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', u.pathname)) });
      }
      if (u.pathname.startsWith('/api/')) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: answer(u.pathname) }),
        });
      }
      return route.abort();
    });
    await page.goto(`${HOST}/${url}`, { waitUntil: 'load' });
    let ready = false;
    try {
      await page.waitForSelector('[data-print-ready="true"]', { timeout: 25_000 });
      ready = true;
    } catch { /* reported through `ready` */ }
    // Anything raised in the moments after ready still counts.
    await page.waitForTimeout(500);
    return { errors, ready };
  } finally {
    await page.close();
  }
}

const boardAnswer = (input: typeof demoInput) => () => serialisePackPagesDocument(buildBoardPackPages(input));
const managementAnswer = (pathname: string) => (
  pathname === '/api/accounting/reports-pack'
    ? { pack: buildReportPack('management', MANAGEMENT_INPUT, '2026-01-01', '2026-08-31') }
    : []
);

describe('a healthy print page raises nothing until it is print-ready', () => {
  it.each([
    ['the board pack, ISAFlow Demo', '?pack=board', boardAnswer(demoInput)],
    ['the board pack, Brightsphere', '?pack=board', boardAnswer(brightsphereInput)],
    ['the legacy management pack print view', '?pack=management', managementAnswer],
  ] as const)('%s', async (_name, query, answer) => {
    const { errors, ready } = await load(query, answer);
    // Errors first: when a page fails to print, what it raised is the diagnosis.
    expect(errors).toEqual([]);
    expect(ready, 'the page never became print-ready').toBe(true);
  }, 90_000);

  it('is red when the page throws (mutation)', async () => {
    const { errors } = await load('?pack=board', boardAnswer(demoInput), 'setTimeout(function(){ throw new Error("boom") }, 50);');
    expect(errors.join('\n')).toContain('boom');
  }, 90_000);

  it('is red on an unhandled rejection and on a console error (mutation)', async () => {
    const { errors } = await load(
      '?pack=board', boardAnswer(demoInput),
      'Promise.reject(new Error("rejected")); console.error("loud");',
    );
    expect(errors.join('\n')).toContain('unhandledrejection: rejected');
    expect(errors.join('\n')).toContain('console.error: loud');
  }, 90_000);
});
