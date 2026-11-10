/**
 * THE PIXEL WIDTH MODEL IS PRODUCTION'S CHROMIUM: figures and words at every whole size and at fractional ones, the
 * column headings' longest words, the footnote marks, the delta cue and a KPI tile's reason, all measured in the print
 * engine (`launchPrintChromium`, which sets glyphs as production's Gotenberg does).
 *
 * `packFigureWidth.ts` and `packReasonWidth.ts` shape the run from the pack's own face (`packGlyphRuler.ts`): never
 * short of Chromium's width and at most 1/32px over a run (1/16 for a figure and its mark, two runs). Glyphs outside
 * the face are priced from production's image (`tests/unit/printParity/packFallbackWidths.test.ts` holds those tables
 * to it, on velo); here they are held to their rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { HEADING_WORD_PX } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { textPx, type FigureWeight } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { FALLBACK } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import { inFace } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { PACK_TABLE_COLUMN_LABEL } from '@/modules/accounting/services/packs/pages/packTableModel';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KpiTileWithSparkline } from '@/components/accounting/packs/primitives/KpiTileWithSparkline';
import { cellPx, deltaCuePx, deltaText, headingMarkPx, labelMarkPx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { reasonPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
import { measure, type Probe } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const SIZES = Array.from({ length: 35 }, (unused, i) => i + 6).concat([10.0964, 10.5757, 12.4, 16.5, 29.3333]);
const FIGURES = ['(133 500 000)', '9 000 000', '45.0%', '–1 234.5', '−12.0pp', '1.08×', 'n/m', '0123456789', '<0.1%', '(1 000)', 'R 1 000 000'];

const STYLES: Array<[string, Probe, FigureWeight, number | undefined]> = [
  ['400', 'td', 400, 400], ['500', 'td', 500, 500], ['600', 'td', 600, 600], ['kpi', 'kpi', 500, undefined],
];
const SLACK = 1 / 32;
/**
 * Over by at most SLACK, and at a size that is not a multiple of 1/64px by the run's share of two 1/64px size steps:
 * the model sets the font at the size floored to 1/64px, and Chromium at that or a step or two below (8.4px is set at
 * 8.375, 10.15 at 10.125; measured), never above.
 */
const allowedOver = (width: number, fontPx: number): number => SLACK + (Number.isInteger(fontPx * 64) ? 0 : (width * 2) / 64 / fontPx);

describe('figures at every size', () => {
  it.each(STYLES)('weight %s: the model is never short of Chromium and at most 1/32px over', async (unused, probe, weight, cssWeight) => {
    const items = SIZES.flatMap((fontPx) => FIGURES.map((text) => ({ probe, text, fontPx, weight: cssWeight })));
    const res = await measure(browser, items);
    const wrong = res.flatMap((r, i) => {
      const model = textPx(items[i]!.text, items[i]!.fontPx, weight);
      return model < r.widthPx - 1e-6 || model > r.widthPx + allowedOver(model, items[i]!.fontPx) + 1e-6 ? [`${items[i]!.text} at ${items[i]!.fontPx}px: model ${model}, Chromium ${r.widthPx}`] : [];
    });
    expect(wrong).toEqual([]);
  }, 300_000);
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

  it('a footnote marker after a heading adds no more than the model charges', async () => {
    const [plain, marked] = await measure(browser, [
      { probe: 'th', text: 'PRIOR', html: '<span>PRIOR</span>' },
      { probe: 'th', text: 'PRIOR2', html: '<span>PRIOR<sup class="pack-footnote-marker">2</sup></span>' },
    ]);
    expect(marked!.widthPx - plain!.widthPx).toBeLessThanOrEqual(headingMarkPx(2) + 1e-6);
    expect(marked!.widthPx - plain!.widthPx).toBeGreaterThan(headingMarkPx(2) - 2 * SLACK);
  });
});

describe('a KPI tile\'s not-meaningful reason (11pt italic, `.pack-kpi-unavailable`)', () => {
  const asClass = (text: string) => ({ probe: 'label' as const, text, html: `<span class="pack-kpi-unavailable" style="white-space:pre">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>` });
  const OWN = [...Array.from({ length: 0x2c00 - 0x21 }, (unused, i) => String.fromCodePoint(i + 0x21))].filter((c) => inFace(c) && !/[\p{M}\p{C}\p{Z}]/u.test(c));

  it('every glyph of the pack\'s own face, alone, and whole words: never short, at most 1/32px over', async () => {
    const words = ['unavailable', 'Insufficient data', 'nnnnnnnnnnnnnnnnnnnn', 'abcdefghijklmnopqrstuvwxyz', 'No basis', 'Current period', 'Not meaningful', 'caf\u00e9\u2019s', '\u201cquoted\u201d', 'x\u00d7y\u2014z', 'AVATAR WAVE'];
    const texts = [...OWN, ...words];
    const res = await measure(browser, texts.map(asClass));
    const wrong = texts.flatMap((t, i) => (reasonPx(t) < res[i]!.widthPx - 1e-6 || reasonPx(t) > res[i]!.widthPx + SLACK + 1e-6
      ? [`${JSON.stringify(t)}: model ${reasonPx(t)}, Chromium ${res[i]!.widthPx}`] : []));
    expect(OWN.length).toBeGreaterThan(800);
    expect(wrong).toEqual([]);
  }, 300_000);

  // The adversary's round 3: an emoji presentation was charged as its text glyph with a free selector (ℹ️ 4px, an 18px
  // emoji in Chromium), and a reason of them passed the gate and overflowed by up to 237px.
  it('an emoji presentation (VS16, a keycap) costs at least the widest emoji, never its text glyph', () => {
    for (const seq of ['\u2139\uFE0F', '\u2665\uFE0F', '\u2764\uFE0F', '\u00AE\uFE0F', '1\uFE0F\u20E3', '#\uFE0F\u20E3']) {
      expect(reasonPx(seq), JSON.stringify(seq)).toBeGreaterThanOrEqual(FALLBACK.reason.emoji);
    }
    expect(reasonPx('\u2764\uFE0F'), 'a heart with VS16 is the emoji, wider than the text heart').toBeGreaterThan(reasonPx('\u2764'));
  });

  it('a cluster outside the face costs the sum of its code points: a family, a flag, a skin-toned hand at least their parts', () => {
    expect(reasonPx('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBeGreaterThanOrEqual(3 * reasonPx('\u{1F600}') - 2);
    expect(reasonPx('\u{1F44D}\u{1F3FD}')).toBeGreaterThanOrEqual(reasonPx('\u{1F44D}'));
    expect(reasonPx('\u{3FFFF}')).toBe(FALLBACK.reason.widest + 1 / 64);
  });
});


describe('a footnote mark, at the size it is set at', () => {
  const marks = ['1', '2', '9', '10', '13', '20', 'a', 'b', 'i', 'm', 'w', 'z', 'aa', 'ab', 'mw', 'zz', 'aw'];

  it.each([[10], [11], [12]])('an n/m cell with its mark after a %ipx figure is the model\'s (never short, at most 1/16px over), at every weight', async (host) => {
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
        if (model < measured - 1e-6 || model > measured + 2 * SLACK + 1e-6) wrong.push(`${host}px ${weight} "${m}": model ${model} vs ${measured} (n/m alone ${base})`);
      });
    });
    expect(wrong).toEqual([]);
  });

  it.each([[400], [500], [600]] as const)('a 9pt label with its footnote number at weight %i is the model\'s (never short, at most 1/16px over), one digit and two', async (weight) => {
    const numbers = [1, 5, 9, 10, 13, 20, 31];
    const res = await measure(browser, [
      { probe: 'label' as const, text: 'x', weight, html: '<span>Revenue</span>' },
      ...numbers.map((n) => ({ probe: 'label' as const, text: String(n), weight, html: `<span>Revenue<sup class="pack-footnote-marker">${n}</sup></span>` })),
    ]);
    const wrong = numbers.flatMap((n, i) => {
      const model = textPx('Revenue', 12, weight) + labelMarkPx(n, weight);
      return model < res[i + 1]!.widthPx - 1e-6 || model > res[i + 1]!.widthPx + 2 * SLACK + 1e-6 ? [`${n}: model ${model}, Chromium ${res[i + 1]!.widthPx}`] : [];
    });
    expect(wrong).toEqual([]);
  });

  it('a heading\'s footnote number, with its letter-spacing, is the model\'s: never short, at most 1/16px over', async () => {
    const numbers = [1, 7, 10, 22];
    const res = await measure(browser, [
      { probe: 'th' as const, text: 'x', html: '<span>PRIOR</span>' },
      ...numbers.map((n) => ({ probe: 'th' as const, text: String(n), html: `<span>PRIOR<sup class="pack-footnote-marker">${n}</sup></span>` })),
    ]);
    const wrong = numbers.filter((n, i) => { const m = res[i + 1]!.widthPx - res[0]!.widthPx; return headingMarkPx(n) < m - 1e-6 || headingMarkPx(n) > m + 2 * SLACK; });
    expect(wrong).toEqual([]);
  });
});

describe('a delta line\'s arrow cue, in the real tile', () => {
  it('the real tile\'s delta line is the cue, a space and the words: the model\'s deltaCuePx and deltaText', async () => {
    const tile = {
      label: 'Revenue', figure: { source: 'is.revenue', value: 1000, format: 'money' },
      delta: { value: 12.3, unit: 'percent', basis: 'prior period', favourable: true }, trendFootnote: null, sparklineSvg: null,
    } as unknown as Parameters<typeof deltaText>[0];
    const markup = renderToStaticMarkup(createElement(KpiTileWithSparkline, { tile: tile as never, scale: "R'000" }));
    const delta = /<span class="pack-kpi-delta[^"]*">(.*?)<\/span><\/div>$/.exec(markup)?.[0] ?? '';
    expect(delta, 'the real tile\'s delta span').toContain('pack-kpi-delta-cue');
    const alone = (html: string) => ({ probe: 'label' as const, text: 'x', html: `<span style="white-space:nowrap">${html}</span>` });
    const res = await measure(browser, [
      alone(delta.replace(/<\/div>$/, '')),
      alone(delta.replace(/<span class="pack-kpi-delta-cue"[^>]*>.*?<\/span>\s*/, '').replace(/<\/div>$/, '')),
    ]);
    // with the cue and without it: the difference is the cue's own run and the space after it, never more than the model.
    const cue = res[0]!.widthPx - res[1]!.widthPx;
    expect(deltaCuePx() + textPx(' ', 12, 400)).toBeGreaterThanOrEqual(cue - 1e-6);
    expect(deltaCuePx() + textPx(' ', 12, 400)).toBeLessThanOrEqual(cue + 2 * SLACK + 1e-6);
  });
});
