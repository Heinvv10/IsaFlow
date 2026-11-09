/**
 * THE KPI MODEL'S LEADINGS ARE CHROMIUM'S, TO ITS 1/64px UNIT.
 *
 * `packKpiLayout.ts` charges a label or delta line `LABEL_LINE_MM`, a not-meaningful reason line `REASON_LINE_MM`, a
 * figure `FIGURE_LINE_MM`, and a delta's first line `DELTA_CUE_MM` more (its 7pt arrow cue). Each is re-measured here
 * from the pack's own stylesheet in production's layout (`launchPrintChromium`): a tile's part set on one line and on
 * two, the second line's height being the leading. They are the CSS line-heights as Chromium sets them (12pt is
 * 16px; 14pt, 18.667px, is set at 18.671875; 25pt, 33.333px, at 33.328125). A CSS change that moves a line-height goes
 * red here before it moves a page.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import {
  DELTA_CUE_MM, FIGURE_LINE_MM, LABEL_LINE_MM, REASON_LINE_MM,
} from '@/modules/accounting/services/packs/pages/packKpiLayout';
import { launchPrintChromium } from './printChromium';
import { printStylesheet } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
/** The same length, two ways of computing it: float noise only. */
const SAME = 1e-9;

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const tile = (inner: string, widthPx: number): string => `<div class="pack-kpi-tile" style="width:${widthPx}px">${inner}</div>`;
const CUE = '<span class="pack-kpi-delta-cue" aria-hidden="true">↑</span> ';
const PARTS = {
  label: (w: number) => tile('<span class="pack-kpi-label">Operating profit</span>', w),
  reason: (w: number) => tile('<span class="pack-kpi-unavailable">Revenue is not positive</span>', w),
  figure: () => tile('<span class="pack-kpi-value">1 234 567</span>', 400),
  delta: (w: number) => tile(`<span class="pack-kpi-delta is-favourable">${CUE}up 12.0% prior period</span>`, w),
};

it('the label, reason, figure and delta-cue leadings are the ones Chromium sets', async () => {
  const cases = [
    PARTS.label(400), PARTS.label(70), PARTS.reason(400), PARTS.reason(120), PARTS.figure(), PARTS.delta(400), PARTS.delta(80),
  ];
  const body = `<div class="pack-pages"><div class="pack-page">${cases.map((c, i) => `<div id="c${i}">${c}</div>`).join('')}</div></div>`;
  const html = `<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${printStylesheet()}</style></head><body>${body}</body></html>`;
  const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
  try {
    await page.route(`${HOST}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      if (url.pathname.startsWith('/fonts/')) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', url.pathname)) });
      return route.abort();
    });
    await page.goto(HOST, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => {
      await Promise.all([400, 500, 600].map((w) => document.fonts.load(`${w} 16px "IBM Plex Sans"`)));
      await document.fonts.ready;
    });
    const mm = await page.evaluate(() => Array.from(document.querySelectorAll('.pack-kpi-tile > span'))
      .map((el) => ({ mm: el.getBoundingClientRect().height * 25.4 / 96 })));
    const [label1, label2, reason1, reason2, figure, delta1, delta2] = mm;
    expect(label2!.mm - label1!.mm, 'the narrow label must take a second line').toBeGreaterThan(1);
    expect(reason2!.mm - reason1!.mm, 'the narrow reason must take a second line').toBeGreaterThan(1);
    expect(delta2!.mm - delta1!.mm, 'the narrow delta must take a second line').toBeGreaterThan(1);
    const leading = { label: label2!.mm - label1!.mm, reason: reason2!.mm - reason1!.mm, delta: delta2!.mm - delta1!.mm };
    const near = (got: number, want: number, what: string): void => { expect(Math.abs(got - want), `${what}: ${got} vs ${want}`).toBeLessThan(SAME); };
    near(label1!.mm, LABEL_LINE_MM, 'a label line');
    near(leading.label, LABEL_LINE_MM, 'a label\'s second line');
    near(leading.delta, LABEL_LINE_MM, 'a delta\'s second line');
    near(reason1!.mm, REASON_LINE_MM, 'a reason line');
    near(leading.reason, REASON_LINE_MM, 'a reason\'s second line');
    near(figure!.mm, FIGURE_LINE_MM, 'a figure');
    near(delta1!.mm - leading.delta, DELTA_CUE_MM, 'a delta\'s first line, past its leading');
  } finally {
    await page.close();
  }
}, 120_000);
