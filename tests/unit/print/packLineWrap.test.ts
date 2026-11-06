/**
 * WHERE THE MODEL MAY BREAK A LABEL IS WHERE CHROMIUM BREAKS IT.
 *
 * `packLineWrap.pieces` splits text at spaces, after hyphens (also before a digit, but not a hyphen opening a signed
 * number), after an en dash and around an em dash, and nowhere else (not at a slash, dot, comma, colon, ampersand
 * or plus). For each text, Chromium's min-content width of the label is the widest of its pieces, each measured
 * on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { linesFor, minPx, pieces, runsOf } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { measure } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const TEXTS = [
  '2024-25', 'abc-def', 'abc-5', 'abc/def', 'abc/5', '1/2', 'abc–def', '5–6', 'abc—def', '-5', '-abc', '(abc-def)',
  'abc--def', 'a-b-c', 'Fy2024/25', 'abc.def', 'abc,def', 'abc:def', 'abc;def', 'abc_def', 'abc&def', 'abc+def', 'R&D',
  'Revenue from contracts', 'Non-operating-income-from-associates', 'Property, plant and equipment (net)',
];

describe('the pieces of a label', () => {
  it.each(TEXTS)('%s: Chromium\'s narrowest width is the widest of the pieces the model breaks it into', async (text) => {
    const probes = [
      { probe: 'label' as const, text, html: `<span style="display:inline-block;width:min-content;white-space:normal">${text}</span>` },
      ...pieces(text).map((piece) => ({ probe: 'label' as const, text: piece.text, html: `<span style="white-space:nowrap">${piece.text}</span>` })),
    ];
    const res = await measure(browser, probes);
    expect(res[0]!.widthPx).toBeCloseTo(Math.max(...res.slice(1).map((r) => r.widthPx)), 0);
  });
});

describe('the fill', () => {
  const runs = runsOf('Operating expenses', (piece) => textPx(piece, 12, 400), 3);

  it('a piece that fits with less than the guard to spare takes a line it may not need, never one too few', () => {
    const full = runs.reduce((sum, r) => sum + r.gap + r.w, 0);
    expect(linesFor(runs, 0, full)).toBe(2);
    expect(linesFor(runs, 0, full + 1)).toBe(1);
  });

  it('a footnote mark sits on the last piece: it widens the narrowest width only if the last piece is the widest', () => {
    const wide = runsOf('Intercompanyrecharges net', (piece) => textPx(piece, 12, 400), 3);
    expect(minPx(wide, 10)).toBe(textPx('Intercompanyrecharges', 12, 400));
    const last = runsOf('net Intercompanyrecharges', (piece) => textPx(piece, 12, 400), 3);
    expect(minPx(last, 10)).toBe(textPx('Intercompanyrecharges', 12, 400) + 10);
  });
});
