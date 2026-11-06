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
import { cellPx, DELTA_CUE_PX, headingMarkPx, labelMarkPx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { reasonPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
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

describe('a KPI tile\'s not-meaningful reason (11pt italic, `.pack-kpi-unavailable`)', () => {
  // Every glyph the table covers (the soft hyphen, U+00AD, is invisible: it measures 0 and is charged the widest, over): Basic Latin, Latin-1, Latin Extended-A and the typographic punctuation.
  const reasonChars = [
    ...Array.from({ length: 0x180 - 0x20 }, (unused, i) => i + 0x20).filter((c) => (c < 0x7f || c > 0x9f) && c !== 0xad).map((c) => String.fromCodePoint(c)),
    ...'‘’“”–—…×÷·•€£¢¥®©°±§¶¼½¾²³¹−‐‑‒―′″',
  ];
  const asClass = (text: string) => ({ probe: 'label' as const, text, html: `<span class="pack-kpi-unavailable">${text}</span>` });

  it('every glyph is the whole-pixel advance the italic face sets, to the pixel and never short', async () => {
    const res = await measure(browser, [asClass('||'), ...reasonChars.map((c) => asClass(`|${c}|`))]);
    const bar = res[0]!.widthPx;
    const wrong = reasonChars.filter((c, i) => {
      const measured = res[i + 1]!.widthPx - bar;
      return reasonPx(c) < measured - 0.01 || reasonPx(c) > measured + 1;
    }).map((c) => `${c} U+${c.codePointAt(0)!.toString(16)}: model ${reasonPx(c)}`);
    expect(wrong).toEqual([]);
  });

  it('a glyph outside the table is charged the widest the table holds, which is no narrower than any of them', async () => {
    const widest = Math.max(...reasonChars.map((c) => reasonPx(c)));
    expect(reasonPx('\u0e01')).toBe(widest);
    expect(widest).toBe(15);
  });

  it('whole words, as the tile sets them, are the model\'s sum within a pixel a word and never short', async () => {
    const words = ['unavailable', 'Insufficientdata', 'nnnnnnnnnnnnnnnnnnnn', 'abcdefghijklmnopqrstuvwxyz', 'Nobasis', 'Currentperiod', 'Notmeaningful', 'caf\u00e9\u2019s', '\u201cquoted\u201d', 'x\u00d7y\u2014z'];
    const res = await measure(browser, words.map(asClass));
    const wrong = words.filter((w, i) => reasonPx(w) < res[i]!.widthPx - 0.01 || reasonPx(w) > res[i]!.widthPx + 2).map((w) => w);
    expect(wrong).toEqual([]);
  });
});

describe('a footnote mark, at the size it is set at', () => {
  const marks = ['1', '2', '9', '10', '13', '20', 'a', 'b', 'i', 'm', 'w', 'z', 'aa', 'ab', 'mw', 'zz', 'aw'];

  it.each([[10], [11], [12]])('an n/m cell\'s mark after a %ipx figure is the model\'s, at every weight', async (host) => {
    const weights = [400, 500, 600] as const;
    const items = weights.flatMap((weight) => [
      { probe: 'td' as const, text: 'x', fontPx: host, weight, html: '<span>n/m</span>' },
      ...marks.map((m) => ({ probe: 'td' as const, text: m, fontPx: host, weight, html: `<span>n/m<sup class="pack-table-note-mark">${m}</sup></span>` })),
    ]);
    const res = await measure(browser, items);
    const wrong: string[] = [];
    weights.forEach((weight, w) => {
      const base = res[w * (marks.length + 1)]!.widthPx;
      marks.forEach((m, i) => {
        const measured = res[w * (marks.length + 1) + 1 + i]!.widthPx;
        const model = cellPx({ text: 'n/m', weight, mark: m }, host);
        if (model < measured - 0.01 || model > measured + 0.01) wrong.push(`${host}px ${weight} "${m}": model ${model} vs ${measured} (n/m alone ${base})`);
      });
    });
    expect(wrong).toEqual([]);
  });

  it('a row\'s or tile\'s footnote number after its 9pt label is the model\'s, one digit and two', async () => {
    const numbers = [1, 5, 9, 10, 13, 20, 31];
    const res = await measure(browser, [
      { probe: 'label' as const, text: 'x', html: '<span>Revenue</span>' },
      ...numbers.map((n) => ({ probe: 'label' as const, text: String(n), html: `<span>Revenue<sup class="pack-footnote-marker">${n}</sup></span>` })),
    ]);
    const wrong = numbers.filter((n, i) => Math.abs(labelMarkPx(n) - (res[i + 1]!.widthPx - res[0]!.widthPx)) > 0.01).map((n) => `${n}: ${labelMarkPx(n)}`);
    expect(wrong).toEqual([]);
  });

  it('a heading\'s footnote number, with its letter-spacing, is the model\'s within 0.05px a digit and never short', async () => {
    const numbers = [1, 7, 10, 22];
    const res = await measure(browser, [
      { probe: 'th' as const, text: 'x', html: '<span>PRIOR</span>' },
      ...numbers.map((n) => ({ probe: 'th' as const, text: String(n), html: `<span>PRIOR<sup class="pack-footnote-marker">${n}</sup></span>` })),
    ]);
    const wrong = numbers.filter((n, i) => { const m = res[i + 1]!.widthPx - res[0]!.widthPx; return headingMarkPx(n) < m - 0.001 || headingMarkPx(n) > m + 0.05 * String(n).length; });
    expect(wrong).toEqual([]);
  });
});

describe('a delta line\'s arrow cue', () => {
  it('is its own 7px run: "\u2191 up" is the cue, a 3px space and "up"', async () => {
    const res = await measure(browser, [
      { probe: 'label' as const, text: 'cue', html: '<span class="pack-kpi-delta"><span class="pack-kpi-delta-cue">\u2191</span></span>' },
      { probe: 'label' as const, text: 'up', html: '<span class="pack-kpi-delta">up</span>' },
      { probe: 'label' as const, text: 'both', html: '<span class="pack-kpi-delta"><span class="pack-kpi-delta-cue">\u2191</span> up</span>' },
    ]);
    expect(res[0]!.widthPx).toBe(DELTA_CUE_PX);
    expect(res[2]!.widthPx).toBe(res[0]!.widthPx + textPx(' ', 12, 400) + res[1]!.widthPx);
  });
});
