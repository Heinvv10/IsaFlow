/**
 * THE MANAGEMENT PACK'S BRIDGE, RASTERISED BY CHROMIUM.
 *
 * Two defects reached a Gotenberg render of the Demo company's management
 * pack that no geometry on the SVG could have settled alone:
 *
 *  - the (1 500 000) gridline ran THROUGH "1 430 581" and "(1 329 181)",
 *    visible between every group of digits, because the only thing behind
 *    those figures was a paper halo two pixels deep on each glyph;
 *  - the chart's axis text was set in DejaVu Sans Mono — the theme asks for
 *    IBM Plex Mono, which the print page does not load.
 *
 * So this draws that chart as the print view draws it (the app's chart theme
 * registered, the view's own option), puts it on a page with the pack's real
 * print stylesheet and self-hosted faces, and asks Chromium:
 *
 *  - PIXELS. The chart is rasterised twice, once as drawn and once with every
 *    horizontal rule taken out of the SVG. Under the two figures the two
 *    rasters must be identical — a rule that shows through anywhere in a
 *    figure's box is a pixel that differs.
 *  - FONTS. The page is printed, and the PDF may embed IBM Plex Sans and
 *    nothing else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { LEGACY_WATERFALL_BOX } from '@/components/accounting/packs/PackSectionView';
import { boxOf, figures } from '../services/packs/support/bridgeSvg';
import { DEMO_MANAGEMENT_BRIDGE, renderLegacyBridge } from '../services/packs/support/legacyBridge';
import { printStylesheet, withChromium } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
const SCALE = 2;
const RULE = /<path d="M[-\d.]+ ([-\d.]+)L[-\d.]+ \1"[^>]*><\/path>/g;

const chart = renderLegacyBridge(DEMO_MANAGEMENT_BRIDGE, LEGACY_WATERFALL_BOX.widthPx, LEGACY_WATERFALL_BOX.heightPx);
const withoutRules = chart.replace(RULE, '');

async function open(page: Page): Promise<void> {
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${printStylesheet()}</style></head><body>`
    + `<div id="drawn" style="width:${LEGACY_WATERFALL_BOX.widthPx}px">${chart}</div>`
    + `<div id="bare" style="width:${LEGACY_WATERFALL_BOX.widthPx}px">${withoutRules}</div></body></html>`;
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
  // The pack's faces are `font-display: block`: wait, or measure a fallback.
  await page.evaluate(async () => { await document.fonts.load("400 12px 'IBM Plex Sans'", '0123456789()'); await document.fonts.ready; });
}

async function pixels(page: Page, id: string): Promise<{ data: Buffer; width: number; height: number }> {
  const png = await page.locator(`#${id} svg`).screenshot();
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Pixels that differ between two rasters inside a box given in SVG units. */
function differing(a: { data: Buffer; width: number }, b: { data: Buffer }, box: { left: number; right: number; top: number; bottom: number }): number {
  let count = 0;
  for (let y = Math.floor(box.top * SCALE); y < Math.ceil(box.bottom * SCALE); y += 1) {
    for (let x = Math.floor(box.left * SCALE); x < Math.ceil(box.right * SCALE); x += 1) {
      const at = (y * a.width + x) * 3;
      if (Math.abs(a.data[at]! - b.data[at]!) + Math.abs(a.data[at + 1]! - b.data[at + 1]!) + Math.abs(a.data[at + 2]! - b.data[at + 2]!) > 12) count += 1;
    }
  }
  return count;
}

/** Every font the PDF embeds, with Chromium's six-letter subset tag stripped. */
function embeddedFonts(pdf: Buffer): string[] {
  return [...new Set([...pdf.toString('latin1').matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/>\]]+)/g)].map((m) => m[1]!))].sort();
}

describe('the management pack\'s bridge in Chromium', () => {
  it('shows no rule through "1 430 581" or "(1 329 181)"', async () => {
    const drawnFigures = figures(chart).map((f) => ({ ...f, text: f.text.replace(/\s/g, ' ') }));
    const named = ['1 430 581', '(1 329 181)'].map((text) => drawnFigures.find((f) => f.text === text));
    expect(named.every((f) => f !== undefined), `the chart prints ${drawnFigures.map((f) => f.text).join(', ')}`).toBe(true);
    // The case is the one evidenced: a rule's y lies inside each figure's box.
    const rules = [...chart.matchAll(RULE)].map((m) => Number(m[1]));
    for (const f of named) expect(rules.some((y) => y > boxOf(f!).top && y < boxOf(f!).bottom), `no rule crosses "${f!.text}"`).toBe(true);

    const { drawn, bare } = await withChromium(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: SCALE });
      try {
        await open(page);
        return { drawn: await pixels(page, 'drawn'), bare: await pixels(page, 'bare') };
      } finally {
        await page.close();
      }
    });
    expect(drawn.width).toBe(LEGACY_WATERFALL_BOX.widthPx * SCALE);
    // The rules are there to be seen: the two rasters differ somewhere.
    expect(differing(drawn, bare, { left: 0, right: LEGACY_WATERFALL_BOX.widthPx, top: 0, bottom: LEGACY_WATERFALL_BOX.heightPx })).toBeGreaterThan(500);
    for (const f of named) expect(differing(drawn, bare, boxOf(f!)), `a rule shows through "${f!.text}"`).toBe(0);
  });

  it('embeds IBM Plex Sans and no other face', async () => {
    const pdf = await withChromium(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 1123, height: 794 } });
      try {
        await open(page);
        return await page.pdf({ format: 'A4', printBackground: true });
      } finally {
        await page.close();
      }
    });
    expect(embeddedFonts(pdf)).toEqual(['IBMPlexSans']);
  });
});
