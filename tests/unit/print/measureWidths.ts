/**
 * Measure text in the print engine, as the pack's figure cells and headings are set: the real print
 * stylesheet, the real fonts, the real `.pack-table` / `.pack-kpi-value` / `.pack-table th` rules. Used to
 * hold `packFigureWidth.ts` and `packFigureFit.ts`'s constants to Chromium.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { printStylesheet } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';

export type Probe = 'td' | 'kpi' | 'th' | 'label';

export interface Measurement { probe: Probe; text: string; fontPx: number | null; widthPx: number }

/** Widths of each text under each probe, at each font size (null = the stylesheet's own size). */
export async function measure(
  browser: Browser,
  items: ReadonlyArray<{ probe: Probe; text: string; fontPx?: number; html?: string; weight?: number; rowClass?: string }>,
): Promise<Measurement[]> {
  const body = '<div class="pack-pages"><div class="pack-page"><table class="pack-table"><thead><tr><th id="th">x</th></tr></thead>'
    + '<tbody><tr><td id="label">x</td><td id="td">x</td></tr></tbody></table><span class="pack-kpi-value" id="kpi">x</span></div></div>';
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>' + printStylesheet()
    + `</style></head><body>${body}</body></html>`;
  const page = await browser.newPage({ viewport: { width: 658, height: 1000 } });
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
    // Fonts load on first use: a weight no text has used yet is not loaded, and measuring it falls back to a
    // synthetic face. Load the three the pack's figures are set in before measuring anything.
    await page.evaluate(async () => {
      await Promise.all([400, 500, 600].map((w) => document.fonts.load(`${w} 16px "IBM Plex Sans"`)));
      await document.fonts.ready;
    });
    return await page.evaluate((list) => list.map((item) => {
      const el = document.getElementById(item.probe)!;
      if (el.parentElement?.tagName === 'TR') el.parentElement.className = item.rowClass ?? '';
      if (item.html !== undefined) el.innerHTML = item.html; else el.textContent = item.text;
      el.style.fontSize = item.fontPx === undefined ? '' : `${item.fontPx}px`;
      el.style.fontWeight = item.weight === undefined ? '' : String(item.weight);
      const probe = document.createElement('span');
      while (el.firstChild) probe.appendChild(el.firstChild);
      el.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      el.textContent = 'x';
      return { probe: item.probe, text: item.text, fontPx: item.fontPx ?? null, widthPx: width };
    }), items);
  } finally {
    await page.close();
  }
}
