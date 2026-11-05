/**
 * THE PIXEL WIDTH MODEL IS CHROMIUM'S: every character at every whole size, the font-size snapping, the
 * column headings' longest words, and the label words, all measured in the print engine.
 *
 * `packFigureWidth.ts` says a glyph is `round(em x round(fontPx))` pixels wide; `packFigureFit.ts` says what the
 * longest word of each heading is. Either drifting (a font update, a Chromium change) turns a fitting row into
 * an overflowing one with nothing else to notice, so both are held here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { HEADING_WORD_PX } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { advancePx, effectivePx, textPx, type FigureWeight } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { PACK_TABLE_COLUMN_LABEL } from '@/modules/accounting/services/packs/pages/packTableModel';
import { measure, type Probe } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const CHARS = [...'0123456789 ()+-./%<,:'].concat([' ', '–', '−', '×'], [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ']);
const SIZES = Array.from({ length: 35 }, (unused, i) => i + 6);
/** Kerned against the `|` the measurement is taken between, or hinted irregularly: their em is an upper bound. */
const UPPER_BOUND = new Set(['x', 'y', 'E', 'M', 'O', 'Q', 'I', '/', 'k', 's', 'C']);

const STYLES: Array<[string, Probe, FigureWeight, number | undefined]> = [
  ['400', 'td', 400, 400], ['500', 'td', 500, 500], ['600', 'td', 600, 600], ['kpi', 'kpi', 500, undefined],
];

describe('every character at every whole pixel size', () => {
  it.each(STYLES)('weight %s: the model\'s advance is the measured one (an upper bound only for the kerned few)', async (unused, probe, weight, cssWeight) => {
    const items = SIZES.flatMap((fontPx) => [
      { probe, text: '||', fontPx, weight: cssWeight },
      ...CHARS.map((c) => ({ probe, text: `|${c}|`, fontPx, weight: cssWeight })),
    ]);
    const res = await measure(browser, items);
    const wrong: string[] = [];
    let i = 0;
    for (const fontPx of SIZES) {
      const base = res[i++]!.widthPx;
      for (const c of CHARS) {
        const measured = res[i++]!.widthPx - base;
        const model = advancePx(c, fontPx, weight);
        const ok = UPPER_BOUND.has(c) ? model >= measured - 0.01 && model <= measured + 4 : Math.abs(model - measured) < 0.02;
        if (!ok) wrong.push(`${JSON.stringify(c)} at ${fontPx}px: model ${model}, measured ${measured}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 300_000);
});

describe('whole strings, and a fractional size', () => {
  it('a figure at a fractional size is laid out at the whole size it snaps to', async () => {
    const texts = ['(133 500 000)', '9 000 000', '45.0%'];
    const sizes = [10.0964, 10.5757, 12.4, 29.3333, 16.5];
    const res = await measure(browser, texts.flatMap((text) => sizes.map((fontPx) => ({ probe: 'td' as const, text, fontPx, weight: 400 }))));
    const wrong = res.filter((r) => Math.abs(textPx(r.text, r.fontPx!, 400) - r.widthPx) > 0.02)
      .map((r) => `${r.text} at ${r.fontPx}px: model ${textPx(r.text, r.fontPx!, 400)}, measured ${r.widthPx}`);
    expect(wrong).toEqual([]);
    expect([10.4, 10.5, 10.6, 29.3333].map(effectivePx)).toEqual([10, 11, 11, 29]);
  });
});

describe('the longest word of each column heading', () => {
  it('is what `.pack-table th` sets (8pt, uppercase, 0.06em tracking), to within a pixel and never short', async () => {
    const entries = Object.entries(PACK_TABLE_COLUMN_LABEL) as Array<[keyof typeof HEADING_WORD_PX, string]>;
    const words = entries.flatMap(([col, label]) => label.split(' ').map((word) => ({ col, word })));
    const res = await measure(browser, words.map(({ word }) => ({ probe: 'th' as const, text: word.toUpperCase(), html: `<span style="text-transform:uppercase">${word}</span>` })));
    const widest = new Map<string, number>();
    words.forEach(({ col }, i) => widest.set(col, Math.max(widest.get(col) ?? 0, res[i]!.widthPx)));
    const wrong = [...widest].filter(([col, px]) => HEADING_WORD_PX[col as keyof typeof HEADING_WORD_PX] < px - 0.01
      || HEADING_WORD_PX[col as keyof typeof HEADING_WORD_PX] > px + 1)
      .map(([col, px]) => `${col}: model ${HEADING_WORD_PX[col as keyof typeof HEADING_WORD_PX]}, measured ${px.toFixed(2)}`);
    expect(wrong).toEqual([]);
  });

  it('a footnote marker after a heading adds at most the 5px the model charges', async () => {
    const [plain, marked] = await measure(browser, [
      { probe: 'th', text: 'PRIOR', html: '<span>PRIOR</span>' },
      { probe: 'th', text: 'PRIOR2', html: '<span>PRIOR<sup class="pack-footnote-marker">2</sup></span>' },
    ]);
    expect(marked!.widthPx - plain!.widthPx).toBeLessThanOrEqual(5);
    expect(marked!.widthPx - plain!.widthPx).toBeGreaterThan(3);
  });
});
