/**
 * WHETHER A LINE HOLDS ONE MORE PIECE IS DECIDED AS CHROMIUM'S LINE BREAKER DECIDES IT: each inline box at its exact
 * advance sum floored to the 1/64px unit (`packGlyphRuler.fitUnitsPx`, with `FIT_NOISE_UNITS` for Chromium's own float
 * noise), never at the never-short width a column is sized by.
 *
 * For each case, the narrowest width (to the unit) at which Chromium keeps the line on one line is searched for, and
 * held to the model's: never narrower (a line the model fits, Chromium fits), and over by at most one unit, on the
 * 630-case grid, 600 random strings of the glyphs all three faces set, a KPI label with its footnote mark, and a delta
 * line with its arrow cue (its own box, at the width Chromium sets it, then a space and the words).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { textFitPx, textPx, ptToPx, type FigureWeight } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { AS_CHROMIUM_SETS } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { labelMarkFitPx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { launchPrintChromium } from './printChromium';
import { openProbePage } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const WEIGHTS: FigureWeight[] = [400, 500, 600];
const FILES = ['IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2'];
const sets = FILES.map((f) => new Set(fontkit.create(readFileSync(path.join(process.cwd(), 'public/fonts', f))).characterSet));
const GLYPHS = [...sets[0]!].filter((c) => sets.every((s) => s.has(c)) && c > 0x20 && c !== 0xad && !/[\p{M}\p{C}\p{Z}]/u.test(String.fromCodePoint(c))).sort((a, b) => a - b);
function* lcg(seed: number): Generator<number> { let s = seed; for (;;) { s = (s * 1103515245 + 12345) % 2147483648; yield s / 2147483648; } }
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

interface Case { name: string; html: string; model: number }

/** The narrowest width, to the unit, at which Chromium sets each case's `html` on one line. */
async function narrowestOneLine(cases: readonly Case[]): Promise<number[]> {
  const page = await openProbePage(browser);
  try {
    return await page.evaluate((list) => {
      const host = document.querySelector('.pack-page')!;
      const boxes = list.map((c) => {
        const d = document.createElement('div');
        d.className = 'pack-kpi-tile';
        d.style.cssText = 'display:block;width:4000px';
        d.innerHTML = c.html;
        host.appendChild(d);
        return d;
      });
      const lines = (d: HTMLElement): number => new Set(Array.from((d.firstElementChild as HTMLElement).getClientRects())
        .filter((r) => r.width > 0).map((r) => Math.round(r.bottom))).size;
      const widest = boxes.map((d) => (d.firstElementChild as HTMLElement).getBoundingClientRect().width);
      const lo = widest.map((w) => Math.floor((w - 2) * 64));
      const hi = widest.map((w) => Math.ceil((w + 2) * 64));
      for (let step = 0; step < 14; step += 1) {
        const mid = lo.map((l, i) => Math.floor((l + hi[i]!) / 2));
        boxes.forEach((d, i) => { d.style.width = `${mid[i]! / 64}px`; });
        boxes.forEach((d, i) => { if (lines(d) === 1) hi[i] = mid[i]!; else lo[i] = mid[i]!; });
      }
      return hi.map((h) => h / 64);
    }, cases.map((c) => ({ html: c.html })));
  } finally {
    await page.close();
  }
}

/** Never narrower than Chromium's; over by at most one unit, on at most `overAtMost` of the cases. */
async function hold(cases: readonly Case[], overAtMost: number): Promise<void> {
  const real = await narrowestOneLine(cases);
  const short = cases.flatMap((c, i) => (c.model < real[i]! - 1e-9 ? [`${c.name}: model fits at ${c.model * 64}/64, Chromium needs ${real[i]! * 64}/64`] : []));
  const far = cases.flatMap((c, i) => (c.model > real[i]! + 1 / 64 + 1e-9 ? [`${c.name}: model ${c.model * 64}/64, Chromium ${real[i]! * 64}/64`] : []));
  const over = cases.filter((c, i) => c.model > real[i]! + 1e-9).length;
  expect(short.slice(0, 10)).toEqual([]);
  expect(far.slice(0, 10)).toEqual([]);
  expect(over, `${over} of ${cases.length} over by a unit`).toBeLessThanOrEqual(overAtMost);
}

/** "a <text>": the piece after the space fits or wraps; the whole line is one text box. */
const lineCase = (text: string, fontPx: number, weight: FigureWeight): Case => ({
  name: `${JSON.stringify(text)} at ${fontPx}px/${weight}`,
  html: `<span style="font-size:${fontPx}px;font-weight:${weight};white-space:normal">a ${esc(text)}</span>`,
  model: textFitPx(`a ${text}`, fontPx, weight),
});

it('the 630-case grid: never narrower than Chromium, over by a unit on at most 1 in 10', async () => {
  const texts = ['(133 500 000)', '9 000 000', 'Telecommunications', 'AVATAR WAVE', 'Revenue', '45.0%', 'To', 'xy', 'Operating expenses', 'W', 'nnnnnnnnnnnnnnnnnnnn', 'R&D', 'Ff', 'office', 'VAT'];
  const sizes = [6, 7, 9, 10, 10.5757, 11, 12, 13.3333, 14.6667, 16, 17, 20.5, 29.3333, 40];
  const cases = texts.flatMap((t) => sizes.flatMap((px) => WEIGHTS.map((w) => lineCase(t, px, w))));
  expect(cases).toHaveLength(630);
  await hold(cases, 63);
}, 300_000);

it('600 random strings of the glyphs every face sets: never narrower than Chromium, over by a unit on at most 1 in 10', async () => {
  const random = lcg(11);
  const next = (): number => random.next().value as number;
  const sizes = [6, 8, 9.3333, 10, 10.5757, 12, 13.3333, 14.6667, 16, 22, 29.3333];
  const cases: Case[] = [];
  for (let i = 0; i < 600; i += 1) {
    let t = '';
    const n = 1 + Math.floor(next() * 14);
    for (let j = 0; j < n; j += 1) t += String.fromCodePoint(GLYPHS[Math.floor(next() * GLYPHS.length)]!);
    cases.push(lineCase(t, sizes[i % sizes.length]!, WEIGHTS[i % 3]!));
  }
  await hold(cases, 60);
}, 300_000);

const LABELS = ['Gross margin', 'Revenue growth', 'Net profit', 'Operating expenses', 'Debt to equity', 'Current ratio', 'Cash conversion', 'Debtor days',
  'Creditor days', 'EBITDA margin', 'Net debt to EBITDA', 'Quick ratio', 'Return on equity', 'Interest cover', 'Gross profit', 'Opex ratio'];

it('a KPI label and its footnote mark, each its own box: never narrower than Chromium', async () => {
  const cases = LABELS.flatMap((label) => [1, 2, 3, 7, 9, 10, 12].map((n) => ({
    name: `${label}${n}`,
    html: `<span class="pack-kpi-label">${label}<sup class="pack-footnote-marker">${n}</sup></span>`,
    model: textFitPx(label, 12, 400) + labelMarkFitPx(n),
  })));
  await hold(cases, 12);
}, 300_000);

it('a delta line: its arrow cue at the width Chromium sets it, then a space and the words: never narrower than Chromium', async () => {
  const cue = (arrow: string): number => textPx(arrow, ptToPx(7), 400, false, AS_CHROMIUM_SETS);
  const cases = ['↑', '↓', '→'].flatMap((arrow) => ['up 12.0%', 'down 3.4%', 'flat on 0.0%', 'up 1 234.5pp'].flatMap((v) =>
    ['prior period', 'budget', 'prior year', 'same month last year'].map((basis) => ({
      name: `${arrow} ${v} ${basis}`,
      html: `<span class="pack-kpi-delta is-favourable"><span class="pack-kpi-delta-cue">${arrow}</span> ${v} ${basis}</span>`,
      model: cue(arrow) + textFitPx(` ${v} ${basis}`, 12, 400),
    }))));
  await hold(cases, 5);
}, 300_000);
