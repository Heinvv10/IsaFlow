/**
 * EVERY X-AXIS LABEL ON A RATIO-TREND CHART IS PAINTED WHOLE.
 *
 * The current month's stub was labelled "Oct 2026 (to date)" on the axis,
 * and Chromium drew it as "Oct 2026 (to date" — the last tick sits on the
 * plot's right edge, half its text runs past the SVG, and the SVG clips it.
 * A jsdom test cannot see that: it lays nothing out.
 *
 * WHY RECHARTS' OWN EDGE-FITTING DID NOT SAVE IT. Recharts pulls an edge
 * label inward by the width it MEASURES, in a span it appends to <body>. The
 * app sets its face (DM Sans) on a wrapper inside the body, not on the body,
 * so the span measures in the browser's default serif — narrower — and the
 * SVG then paints the label in DM Sans, wider than it was allowed for.
 *
 * So the real chart (`RatioTrendChart`) is bundled and drawn in Chromium the
 * same way: the body in a Times-metric serif (Liberation Serif), the chart
 * under a wrapper in DejaVu Sans, which is wider than DM Sans, so a label
 * that fits here fits there. `RATIO_TREND_FONT` (a .woff2 path) swaps the
 * wrapper's face for a real one for a one-off check. At the widths Financial
 * Analysis gives the chart (579px at 1440), over 3, 6 and 12 months ending
 * in a stub — October, and September, whose "Sept 2026*" is the widest — each
 * tick's painted box must lie inside its SVG's.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { bundlePrintPages } from './support/bundlePrintPages';

const HOST = 'http://trend.chart.local/';

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await bundlePrintPages(path.join(__dirname, 'support/ratioTrendChartEntry.tsx'));
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

interface Tick { text: string; left: number; right: number }
interface Drawn { label: string; stub: string; svgLeft: number; svgRight: number; ticks: Tick[] }

async function draw(): Promise<Drawn[]> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2400 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const face = process.env['RATIO_TREND_FONT'];
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>'
      + (face ? "@font-face{font-family:'Probe';src:url(/probe.woff2) format('woff2')}" : '')
      + `[data-case]{font-family:${face ? "'Probe'" : "'DejaVu Sans'"}}</style></head>`
      + '<body style="margin:0;font-family:\'Liberation Serif\'"><div id="root"></div>'
      + `<script>${bundle}</script></body></html>`;
    await page.route(`${HOST}**`, (route) => (new URL(route.request().url()).pathname === '/probe.woff2' && face
      ? route.fulfill({ contentType: 'font/woff2', body: readFileSync(face) })
      : route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })));
    await page.goto(HOST, { waitUntil: 'load' });
    await page.evaluate(async () => { await document.fonts.ready; });
    // A FACE THAT IS NOT THERE IS A FALSE PASS. Chromium substitutes a missing
    // family silently, and the two widths this test turns on are the two
    // faces' own. Each is measured against monospace: if it fell back to
    // monospace the widths are equal.
    const missing = await page.evaluate((families: string[]) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      const width = (font: string): number => { ctx.font = font; return ctx.measureText('Sept 2026* Oct').width; };
      return families.filter((f) => width(`10px ${f}, monospace`) === width('10px monospace'));
    }, ["'Liberation Serif'", face ? "'Probe'" : "'DejaVu Sans'"]);
    if (missing.length > 0) {
      throw new Error(`ratioTrendTicks needs ${missing.join(' and ')} in this browser and it is not installed `
        + '(fonts-liberation / fonts-dejavu-core): without it the check measures a substitute and proves nothing.');
    }
    await page.waitForFunction(() => document.querySelectorAll('[data-case] .recharts-xAxis-tick-labels text').length > 0)
      .catch((e: unknown) => { throw new Error(`the chart never drew: ${errors.join(' | ') || String(e)}`); });
    // ResponsiveContainer measures after mount; let every chart settle.
    await page.waitForTimeout(500);
    return await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-case]')].map((holder) => {
      const svg = holder.querySelector('svg.recharts-surface')!;
      const s = svg.getBoundingClientRect();
      const ticks = [...svg.querySelectorAll('.recharts-xAxis-tick-labels text')].map((t) => {
        const r = t.getBoundingClientRect();
        return { text: t.textContent ?? '', left: r.left, right: r.right };
      });
      return { label: holder.dataset['case'] ?? '', stub: holder.dataset['stub'] ?? '', svgLeft: s.left, svgRight: s.right, ticks };
    }));
  } finally {
    await page.close();
  }
}

describe('the ratio-trend chart\'s x-axis labels', () => {
  it('lie inside the chart at every width the page gives it', async () => {
    const charts = await draw();
    expect(charts).toHaveLength(36);
    // Not vacuous: the widest label the route prints is among them.
    expect(charts.some((c) => c.ticks.at(-1)?.text === 'Sept 2026*')).toBe(true);
    const clipped = charts.flatMap((c) => c.ticks
      .filter((t) => t.left < c.svgLeft - 0.5 || t.right > c.svgRight + 0.5)
      .map((t) => `${c.label}: "${t.text}" spans ${t.left.toFixed(1)}–${t.right.toFixed(1)} in ${c.svgLeft.toFixed(1)}–${c.svgRight.toFixed(1)}`));
    expect(clipped).toEqual([]);
  });

  it('label the stub, and draw it as the last tick', async () => {
    for (const chart of await draw()) {
      expect(chart.ticks.at(-1)?.text, chart.label).toBe(`${chart.stub}*`);
      expect(chart.ticks.filter((t) => t.text.endsWith('*')), chart.label).toHaveLength(1);
    }
  });
});
