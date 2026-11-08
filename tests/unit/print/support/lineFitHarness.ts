/**
 * Holding the line fit (`packGlyphRuler.fitUnitsPx`) to Chromium: for each case, the narrowest width (to the unit) at
 * which Chromium keeps the case's markup on one line, searched for by bisection in the print engine, against the width
 * the model fits it at. A case is the markup the pack prints (a 9pt label with its footnote mark, a delta line with its
 * cue, an 11pt italic reason, a run at a size and weight) and the model's width for it: the line's boxes summed exactly
 * and floored once.
 */
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import { labelMarkExactPx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { ptToPx, textExactPx, textPx, type FigureWeight } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { AS_CHROMIUM_SETS, fitUnitsPx } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { reasonExactPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
import { openProbePage } from '../measureWidths';

export interface Case { name: string; html: string; model: number }

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sup = (n: number | null): string => (n === null ? '' : `<sup class="pack-footnote-marker">${n}</sup>`);

/** A run at `px` and `weight`, a footnote mark after it if `mark`. */
export const runCase = (text: string, px: number, weight: FigureWeight, mark: number | null = null): Case => ({
  name: `${px}px/${weight} ${JSON.stringify(text)}${mark === null ? '' : `^${mark}`}`,
  html: `<span style="font-size:${px}px;font-weight:${weight};white-space:normal">${esc(text)}${sup(mark)}</span>`,
  model: fitUnitsPx(textExactPx(text, px, weight) + (mark === null ? 0 : textExactPx(String(mark), 0.7 * px, weight))),
});

/** A KPI tile's label (9pt) with its footnote mark, as the tile prints it. */
export const labelCase = (text: string, mark: number | null): Case => ({
  name: `label ${JSON.stringify(text)}${mark === null ? '' : `^${mark}`}`,
  html: `<span class="pack-kpi-label">${esc(text)}${sup(mark)}</span>`,
  model: fitUnitsPx(textExactPx(text, 12, 400) + labelMarkExactPx(mark)),
});

/** The widest of the three arrow cues, its own box at the width Chromium sets it. */
export const cuePx = (arrow: string): number => textPx(arrow, ptToPx(7), 400, false, AS_CHROMIUM_SETS);

/** A KPI delta line: the cue, a space and the words (a first line), or the words alone (a later line). */
export const deltaCase = (text: string, arrow: string | null): Case => ({
  name: `delta ${arrow ?? '(later line)'} ${JSON.stringify(text)}`,
  html: arrow === null ? `<span class="pack-kpi-delta is-favourable">${esc(text)}</span>`
    : `<span class="pack-kpi-delta is-favourable"><span class="pack-kpi-delta-cue">${arrow}</span> ${esc(text)}</span>`,
  model: arrow === null ? fitUnitsPx(textExactPx(text, 12, 400)) : fitUnitsPx(cuePx(arrow) + textExactPx(` ${text}`, 12, 400)),
});

/** A KPI tile's not-meaningful reason (11pt italic). */
export const reasonCase = (text: string): Case => ({
  name: `reason ${JSON.stringify(text)}`,
  html: `<span class="pack-kpi-unavailable">${esc(text)}</span>`,
  model: fitUnitsPx(reasonExactPx(text)),
});

/** The narrowest width, to the unit, at which Chromium sets each case on one line. */
export async function narrowestOneLine(browser: Browser, cases: readonly Case[]): Promise<number[]> {
  const out: number[] = [];
  for (let at = 0; at < cases.length; at += 400) {
    const page = await openProbePage(browser);
    try {
      out.push(...await page.evaluate((list) => {
        const host = document.querySelector('.pack-page')!;
        const boxes = list.map((html) => {
          const d = document.createElement('div');
          d.className = 'pack-kpi-tile';
          d.style.cssText = 'display:block;width:8000px';
          d.innerHTML = html;
          host.appendChild(d);
          return d;
        });
        const lines = (d: HTMLElement): number => new Set(Array.from((d.firstElementChild as HTMLElement).getClientRects())
          .filter((r) => r.width > 0).map((r) => Math.round(r.bottom))).size;
        const widest = boxes.map((d) => (d.firstElementChild as HTMLElement).getBoundingClientRect().width);
        const lo = widest.map((w) => Math.floor((w - 3) * 64));
        const hi = widest.map((w) => Math.ceil((w + 3) * 64));
        for (let step = 0; step < 16; step += 1) {
          const mid = lo.map((l, i) => Math.floor((l + hi[i]!) / 2));
          boxes.forEach((d, i) => { d.style.width = `${mid[i]! / 64}px`; });
          boxes.forEach((d, i) => { if (lines(d) === 1) hi[i] = mid[i]!; else lo[i] = mid[i]!; });
        }
        return hi.map((h) => h / 64);
      }, cases.slice(at, at + 400).map((c) => c.html)));
    } finally {
      await page.close();
    }
  }
  return out;
}

/**
 * Never narrower than Chromium's (a line the model fits, Chromium fits); over by at most one unit, on at most
 * `overAtMost` of the cases. Returns how many were over.
 */
export async function hold(browser: Browser, cases: readonly Case[], overAtMost: number): Promise<number> {
  const real = await narrowestOneLine(browser, cases);
  const short = cases.flatMap((c, i) => (c.model < real[i]! - 1e-9 ? [`${c.name}: model fits at ${c.model * 64}/64, Chromium needs ${real[i]! * 64}/64`] : []));
  const far = cases.flatMap((c, i) => (c.model > real[i]! + 1 / 64 + 1e-9 ? [`${c.name}: model ${c.model * 64}/64, Chromium ${real[i]! * 64}/64`] : []));
  const over = cases.filter((c, i) => c.model > real[i]! + 1e-9).length;
  expect(short.slice(0, 10), `${short.length} of ${cases.length} short`).toEqual([]);
  expect(far.slice(0, 10)).toEqual([]);
  expect(over, `${over} of ${cases.length} over by a unit`).toBeLessThanOrEqual(overAtMost);
  return over;
}
