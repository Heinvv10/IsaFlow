/**
 * THE MANAGEMENT PACK'S KPI CARDS ARE LEGIBLE: WCAG AA, 4.5:1.
 *
 * v79's Brightsphere sheet 5 printed its "not meaningful" cards' reasons —
 * "Revenue is not positive, so this ratio has no meaning." — in #9ca3af on
 * white, 2.5:1: the sentence that explains the missing figure, in the
 * palest ink on the sheet. Measured as Chromium computes it in the print
 * view: every text on a card against the background it actually sits on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PackSectionView } from '@/components/accounting/packs/PackSectionView';
import { buildPackDocument } from '@/modules/accounting/services/packs/packDocument';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { DEMO } from './support/printLegacyPack';
import { printStylesheet, withChromium } from './renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';
const AA = 4.5;

/** Brightsphere's shape: revenue a net debit and equity negative, so most cards state a reason. */
const BRIGHTSPHERE = { ...DEMO, revenue: -5_535_000, costOfSales: 0, netProfit: -1_407_763, totalEquity: -9_164_000, totalLiabilities: 13_064_000 };

/**
 * The cards colour their text with Tailwind arbitrary values —
 * `text-[var(--ff-text-tertiary)]` — which the app's build compiles and this
 * harness does not, so every span inherited the body's ink and passed. Each
 * one the markup uses is written as Tailwind writes it: one class, one
 * `color` declaration.
 */
function arbitraryColours(markup: string): string {
  const classes = new Set(markup.match(/text-\[var\(--[\w-]+\)\]/g) ?? []);
  return [...classes].map((c) => `.${c.replace(/[[\]()]/g, (ch) => `\\${ch}`)}{color:${c.slice(6, -1)}}`).join('');
}

async function cardContrasts(print: boolean): Promise<Array<{ text: string; ratio: number; ink: string; packGrey: string }>> {
  const doc = buildPackDocument(buildReportPack('management', BRIGHTSPHERE, '2026-01-01', '2026-09-07'), []);
  const section = doc.sections.find((s) => s.blocks.some((b) => b.kind === 'scorecard'))!;
  const body = renderToStaticMarkup(createElement(PackSectionView, { section }));
  const html = `<!doctype html><html${print ? ' class="print-mode"' : ''}><head><meta charset="utf-8"><style>${printStylesheet()}${arbitraryColours(body)}</style></head><body>${body}</body></html>`;
  return withChromium(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 658, height: 900 } });
    try {
      await page.route(`${HOST}**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (url.pathname.startsWith('/fonts/')) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', url.pathname)) });
        return route.abort();
      });
      await page.goto(HOST, { waitUntil: 'load' });
      if (print) await page.emulateMedia({ media: 'print' });
      return await page.$$eval('.pack-legacy-card span', (spans) => {
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
        const lum = ([r, g, b]: number[]) => [r!, g!, b!].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        const ground = (el: Element | null): number[] => {
          for (let e = el; e !== null; e = e.parentElement) {
            const c = rgb(getComputedStyle(e).backgroundColor);
            if (c.length < 4 || c[3]! > 0) return c.slice(0, 3);
          }
          return [255, 255, 255];
        };
        return spans.filter((s) => (s.textContent ?? '').trim() !== '').map((s) => {
          const [a, b] = [lum(rgb(getComputedStyle(s).color)), lum(ground(s))];
          // The pack's own grey, resolved to the same rgb() form as `color`.
          const probe = document.createElement('i');
          probe.style.color = 'var(--pack-grey-mid)';
          s.appendChild(probe);
          const packGrey = getComputedStyle(probe).color;
          probe.remove();
          return { text: (s.textContent ?? '').slice(0, 50), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), ink: getComputedStyle(s).color, packGrey };
        });
      });
    } finally {
      await page.close();
    }
  });
}

describe('the management pack\'s KPI cards', () => {
  it.each([['printed', true], ['on screen', false]] as const)('%s, set every text, the reasons included, at 4.5:1 or better', async (_name, print) => {
    const found = await cardContrasts(print);
    expect(found.some((f) => /not positive|negative/.test(f.text)), 'no card states a reason, so the pale text is not under test').toBe(true);
    expect(found.filter((f) => f.ratio < AA).map((f) => `${f.ratio.toFixed(2)}:1 "${f.text}"`)).toEqual([]);
  });

  it('printed, in the pack\'s own mid grey — a palette token, not a one-off', async () => {
    const notes = (await cardContrasts(true)).filter((f) => f.ink !== 'rgb(0, 0, 0)' && !/^\(?[\d.]+\)?×$/.test(f.text));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.filter((f) => f.ink !== f.packGrey).map((f) => `${f.ink} "${f.text}"`)).toEqual([]);
  });
});
