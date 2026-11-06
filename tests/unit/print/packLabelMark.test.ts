/**
 * A LABEL'S FOOTNOTE MARK WRAPS WITH THE LABEL'S LAST PIECE, AND THE MODEL CHARGES IT THERE.
 *
 * A statement row's label and a KPI tile's label are set at 9pt with a `FootnoteMarker` superscript straight after
 * the text. `packFigureFit.labelWidestPiecePx` charges the mark to the LAST piece of the label, not to the longest:
 *  - in Chromium, the mark never wraps away from the piece it follows, so a label whose last piece and mark are the
 *    widest is at least that wide (measured with the real component's markup, nothing modelled);
 *  - the model's narrowest label is Chromium's, never short and at most a pixel over, at every weight a row is set in
 *    and for marks of one and two digits. Charging the mark to the longest word over-refuses a "Telecommunications
 *    costs" row by the mark's width; leaving it off under-charges a "Total telecommunications" row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FootnoteMarker } from '@/components/accounting/packs/primitives/FootnoteMarker';
import { labelWidestPiecePx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { measure } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const mark = (n: number): string => renderToStaticMarkup(createElement(FootnoteMarker, { number: n }));
const minContent = (html: string) => `<span style="display:inline-block;width:min-content;white-space:normal">${html}</span>`;
const oneLine = (html: string) => `<span style="white-space:nowrap">${html}</span>`;

/** Labels whose LAST piece, with its mark, is the widest: the mark decides their width only if it stays with it. */
const LAST_IS_WIDEST = [
  'Revenue', 'Cost of telecommunications', 'Net (loss)', 'Rental 2024', 'Interest at 12%', 'Profit pre-tax',
  'Other income.', 'Opex: administration', 'Fy2024/25',
];
/** Labels whose longest piece comes first: the mark after the short last piece adds nothing. */
const LONGEST_FIRST = ['Telecommunications costs', 'Administrative fees', 'Depreciation and other'];
/** Last pieces Chromium may break before the mark at (an ideograph, an emoji): the model may only be over. */
const MAY_BREAK = ['Income 日本', 'Growth \u{1F680}'];
const WEIGHTS = [400, 500, 600] as const;
const MARKS = [1, 12];

describe('in Chromium, a footnote mark wraps with the piece it follows', () => {
  it.each(WEIGHTS)('weight %i: a label is at least as wide as its last piece with the mark after it', async (weight) => {
    const cases = LAST_IS_WIDEST.flatMap((label) => MARKS.map((n) => ({ label, n, last: pieces(label).at(-1)!.text })));
    const res = await measure(browser, cases.flatMap(({ label, n, last }) => [
      { probe: 'label' as const, text: label, weight, html: minContent(`${label}${mark(n)}`) },
      { probe: 'label' as const, text: last, weight, html: oneLine(`${last}${mark(n)}`) },
    ]));
    const wrapped = cases.flatMap((c, i) => (res[2 * i]!.widthPx < res[2 * i + 1]!.widthPx - 0.01
      ? [`${c.label}${c.n}: ${res[2 * i]!.widthPx} < ${res[2 * i + 1]!.widthPx}`] : []));
    expect(wrapped).toEqual([]);
  });
});

describe('the model charges the mark to the last piece', () => {
  it.each(WEIGHTS)('weight %i: the narrowest label is Chromium\'s, never short and at most a pixel over', async (weight) => {
    const cases = [...LAST_IS_WIDEST, ...LONGEST_FIRST].flatMap((label) => MARKS.map((n) => ({ label, n })));
    const res = await measure(browser, cases.map(({ label, n }) => ({ probe: 'label' as const, text: label, weight, html: minContent(`${label}${mark(n)}`) })));
    const wrong = cases.flatMap(({ label, n }, i) => {
      const model = labelWidestPiecePx(label, n, weight);
      return model < res[i]!.widthPx - 0.01 || model > res[i]!.widthPx + 1 ? [`${label}${n}: model ${model}, Chromium ${res[i]!.widthPx}`] : [];
    });
    expect(wrong).toEqual([]);
  });

  it('a mark after an ideograph or an emoji may wrap on its own: the model is never short', async () => {
    const cases = MAY_BREAK.flatMap((label) => MARKS.map((n) => ({ label, n })));
    const res = await measure(browser, cases.map(({ label, n }) => ({ probe: 'label' as const, text: label, html: minContent(`${label}${mark(n)}`) })));
    const short = cases.filter(({ label, n }, i) => labelWidestPiecePx(label, n, 400) < res[i]!.widthPx - 0.01).map(({ label }) => label);
    expect(short).toEqual([]);
  });

  it('pins where the mark goes: after the last piece, not the longest, and not nowhere', () => {
    const longestFirst = labelWidestPiecePx('Telecommunications costs', 12, 400);
    expect(longestFirst).toBe(labelWidestPiecePx('Telecommunications', null, 400));
    expect(labelWidestPiecePx('costs Telecommunications', 12, 400)).toBeGreaterThan(longestFirst);
  });
});
