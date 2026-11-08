/**
 * Holding the line fit (`packGlyphRuler.fitUnitsPx`) to Chromium: for each case, the narrowest width (to the unit) at
 * which Chromium keeps the case's markup on one line, searched for by bisection in the print engine, against the width
 * the model fits it at. A case is the markup the pack prints (a 9pt label with its footnote mark, a delta line with its
 * cue, an 11pt italic reason, a run at a size and weight, a column heading with its mark) and the model's width for it:
 * the line's boxes summed exactly and floored once, or (`fillCase`) the narrowest width at which the production fill
 * sets it on one line.
 */
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import { labelMarkExactPx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { ptToPx, textExactPx, textPx, type FigureWeight } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { AS_CHROMIUM_SETS, fitUnitsPx } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { reasonExactPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
import { headingLineCount } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { openProbePage } from '../measureWidths';

/** `th`: the markup is set inside a statement table's column heading (`.pack-table th`), not a KPI tile. */
export interface Case { name: string; html: string; model: number; th?: boolean }

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

/**
 * A case whose model is the production fill itself: the narrowest width, to the unit, at which `lines(px)` is 1 (searched
 * for by bisection; a fill takes no fewer lines in a narrower box).
 */
export function fillCase(name: string, html: string, lines: (px: number) => number, th = false): Case {
  let lo = 0;
  let hi = 4000 * 64;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (lines(mid / 64) === 1) hi = mid; else lo = mid;
  }
  return { name, html, model: hi / 64, th };
}

/** A column heading line (8pt, 500, uppercase, tracked) with its footnote mark, fitted by `headingLineCount`. */
export const headingCase = (text: string, mark: number | null): Case => fillCase(
  `heading ${JSON.stringify(text)}${mark === null ? '' : `^${mark}`}`, `<span>${esc(text)}${sup(mark)}</span>`,
  (px) => headingLineCount(text, mark ?? undefined, px, 0), true,
);

/** The narrowest width, to the unit, at which Chromium sets each case on one line. */
export async function narrowestOneLine(browser: Browser, cases: readonly Case[]): Promise<number[]> {
  const out: number[] = [];
  for (let at = 0; at < cases.length; at += 400) {
    const page = await openProbePage(browser);
    try {
      out.push(...await page.evaluate((list) => {
        const host = document.querySelector('.pack-page')!;
        const boxes = list.map(({ html, th }) => {
          const d = document.createElement('div');
          d.style.cssText = 'display:block;width:8000px';
          d.innerHTML = html;
          if (th) {
            const table = document.createElement('table');
            table.className = 'pack-table';
            table.innerHTML = '<thead><tr><th></th></tr></thead>';
            table.querySelector('th')!.appendChild(d);
            host.appendChild(table);
          } else {
            d.className = 'pack-kpi-tile';
            host.appendChild(d);
          }
          return d;
        });
        const lines = (d: HTMLElement): number => new Set(Array.from((d.firstElementChild as HTMLElement).getClientRects())
          .filter((r) => r.width > 0).map((r) => Math.round(r.bottom))).size;
        const widest = boxes.map((d) => (d.firstElementChild as HTMLElement).getBoundingClientRect().width);
        // The search runs from 3px under the line as drawn to 12px over it: a line that ends at a soft hyphen needs the
        // hyphen's room (about 5px) that it does not draw. A case not on one line at the top is Infinity (never fitted).
        const lo = widest.map((w) => Math.floor((w - 3) * 64));
        const hi = widest.map((w) => Math.ceil((w + 12) * 64));
        boxes.forEach((d, i) => { d.style.width = `${hi[i]! / 64}px`; });
        const reached = boxes.map((d) => lines(d) === 1);
        for (let step = 0; step < 16; step += 1) {
          const mid = lo.map((l, i) => Math.floor((l + hi[i]!) / 2));
          boxes.forEach((d, i) => { d.style.width = `${mid[i]! / 64}px`; });
          boxes.forEach((d, i) => { if (lines(d) === 1) hi[i] = mid[i]!; else lo[i] = mid[i]!; });
        }
        return hi.map((h, i) => (reached[i] ? h / 64 : Infinity));
      }, cases.slice(at, at + 400).map((c) => ({ html: c.html, th: c.th === true }))));
    } finally {
      await page.close();
    }
  }
  return out;
}

/**
 * Never narrower than Chromium's (a line the model fits, Chromium fits); over by at most `overUnits` units (one, but
 * where the noise margin itself passes a unit: `packGlyphRuler.fitMarginUnits`), on at most `overAtMost` of the cases.
 * Returns how many were over.
 */
export async function hold(browser: Browser, cases: readonly Case[], overAtMost: number, overUnits = 1): Promise<number> {
  const real = await narrowestOneLine(browser, cases);
  const short = cases.flatMap((c, i) => (c.model < real[i]! - 1e-9 ? [`${c.name}: model fits at ${c.model * 64}/64, Chromium needs ${real[i]! * 64}/64`] : []));
  const far = cases.flatMap((c, i) => (c.model > real[i]! + overUnits / 64 + 1e-9 ? [`${c.name}: model ${c.model * 64}/64, Chromium ${real[i]! * 64}/64`] : []));
  const over = cases.filter((c, i) => c.model > real[i]! + 1e-9).length;
  expect(short.slice(0, 10), `${short.length} of ${cases.length} short`).toEqual([]);
  expect(far.slice(0, 10)).toEqual([]);
  expect(over, `${over} of ${cases.length} over by a unit`).toBeLessThanOrEqual(overAtMost);
  return over;
}
