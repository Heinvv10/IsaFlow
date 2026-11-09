/**
 * THE FILL OVER EXACT WIDTHS: the greedy line count, each candidate line measured whole, with its guard; and where a
 * footnote mark sits. (Where text may break is held to Chromium by `packLineBreaks.test.ts`; the fill against
 * Chromium's own lines by `packTableLayout.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { linesForText, minPx, WRAP_GUARD_PX } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { textExactPx, textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { HEADING_PX, headingLineExactPx, headingMarkPx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { headingLineCount, labelLineCount } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { kpiTileLines } from '@/modules/accounting/services/packs/pages/packKpiLayout';
import type { KpiTile } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { AS_CHROMIUM_SETS, CHROMIUM_MOST, fitUnitsPx } from '@/modules/accounting/services/packs/pages/packGlyphRuler';

const width = (text: string): number => textPx(text, 12, 400);
const rounded = { exactPx: width, fontPx: 12 };

describe('the fill', () => {
  const parts = pieces('Operating expenses');
  const full = width('Operating expenses');

  it('a line is measured whole, and a piece that fits with less than the guard to spare takes the next line', () => {
    expect(linesForText(parts, rounded, 0, full + WRAP_GUARD_PX)).toBe(1);
    expect(linesForText(parts, rounded, 0, full + WRAP_GUARD_PX - 1 / 64)).toBe(2);
    expect(linesForText(parts, rounded, 0, width('Operating') + WRAP_GUARD_PX)).toBe(2);
  });

  it('a footnote mark stays with the last piece: it can push that piece to a line of its own', () => {
    expect(linesForText(parts, rounded, 10, full + WRAP_GUARD_PX)).toBe(2);
    expect(linesForText(parts, rounded, 10, full + 10 + WRAP_GUARD_PX)).toBe(1);
  });

  it('the narrowest width is the widest piece, the mark counted with the LAST one it sits after', () => {
    const runs = (text: string) => pieces(text).map((p) => ({ w: width(p.text) }));
    expect(minPx(runs('Intercompanyrecharges net'), 10)).toBe(width('Intercompanyrecharges'));
    expect(minPx(runs('net Intercompanyrecharges'), 10)).toBe(width('Intercompanyrecharges') + 10);
  });
});

describe('a line fits as Chromium\'s line breaker fits it: its exact sum and noise margin floored once', () => {
  // With no guard, a label sets on one line at exactly that width and on two 1/128px narrower. A label whose exact sum
  // is under half a unit past a grid point fits at that grid point, below its exact sum: a fill comparing the raw sum
  // wraps it. One more than half a unit past fits at the next: a fill flooring without the margin keeps it 1/128px
  // narrower. Each kind is found among real labels, so neither check is vacuous.
  const exactPx = (text: string, hyphen: boolean): number => textExactPx(text, 12, 400, hyphen);
  const exact = { exactPx, fontPx: 12 };
  const LABELS = ['Operating expenses', 'Gross margin', 'Revenue growth', 'Net profit', 'Cost of sales', 'Other income', 'Debt to equity', 'Current ratio',
    'Cash conversion', 'Debtor days', 'Interest cover', 'Property plant and equipment', 'Trade and other receivables', 'Finance costs'];
  const fraction = (label: string): number => (exactPx(label, false) * 64) % 1;

  it.each([['under', (f: number) => f > 0.05 && f < 0.45], ['over', (f: number) => f > 0.55 && f < 0.95]] as const)('a label %s half a unit past a grid point', (_kind, kind) => {
    const found = LABELS.filter((label) => kind(fraction(label)));
    expect(found.length, 'no label of this kind: the check is vacuous').toBeGreaterThan(0);
    for (const label of found) {
      const fitted = fitUnitsPx(exactPx(label, false), 12);
      expect(linesForText(pieces(label), exact, 0, fitted, 0), `${label} at ${fitted * 64}/64`).toBe(1);
      expect(linesForText(pieces(label), exact, 0, fitted - 1 / 128, 0), `${label} at ${fitted * 64}/64 less 1/128px`).toBe(2);
    }
  });

  it('a heading\'s footnote mark is a box of its own after the floored words: the words and the box fit, 1/128px less does not', () => {
    for (const [label, mark] of [['Other income', 1], ['Year to date', 3], ['Change on prior', 12]] as const) {
      const width = fitUnitsPx(headingLineExactPx(label), HEADING_PX) + headingMarkPx(mark, CHROMIUM_MOST);
      expect(headingLineCount(label, mark, width, 0), `${label}^${mark}`).toBe(1);
      expect(headingLineCount(label, mark, width - 1 / 128, 0), `${label}^${mark} less 1/128px`).toBe(2);
    }
  });

  // The box is at the widest Chromium sets it (`CHROMIUM_MOST`): a mark whose exact sum sits within Chromium's noise of
  // the next unit takes that unit (six digits, 1962.96 units), so the words and the box rounded up alone do not fit.
  it('a heading mark within the noise of the next unit takes that unit', () => {
    const mark = 999999;
    expect(headingMarkPx(mark, CHROMIUM_MOST) - headingMarkPx(mark, AS_CHROMIUM_SETS)).toBe(1 / 64);
    const words = fitUnitsPx(headingLineExactPx('Other income'), HEADING_PX);
    expect(headingLineCount('Other income', mark, words + headingMarkPx(mark, AS_CHROMIUM_SETS), 0)).toBe(2);
    expect(headingLineCount('Other income', mark, words + headingMarkPx(mark, CHROMIUM_MOST), 0)).toBe(1);
  });

  it('a mark set as a box after a part that ends at a soft hyphen ends the line there: no hyphen\'s room', () => {
    const box = 5;
    const width = fitUnitsPx(exactPx('Ab cd', false), 12) + box;
    expect(linesForText(pieces('Ab cd\u00AD'), exact, 0, width, 0, box)).toBe(1);
  });

  // Each fill measures its margin at its own size (`fitMarginUnits`): a long line set at 12px (a table row label, a KPI
  // label) or 10.67px (a heading) is fitted with that size's margin. A label whose fitted width moves by a unit with the
  // size is set on one line at its own size's fitted width and on two 1/128px under it; read at 14.67px, the margin is
  // smaller and the same label would fit 1/128px under.
  it('every fill measures its line at its own size: a table label at 12px, a KPI label at 12px, a heading at 10.67px', () => {
    const words = 'Intercompany receivables and payables for the financial year ending February subsidiaries'.split(' ');
    const candidates = words.flatMap((unused, i) => [4, 5, 6, 7, 8].map((n) => words.slice(i, i + n).join(' '))).map((c) => `${c} ${c} ${c}`);
    const pick = (exactOf: (t: string) => number, fontPx: number): string => {
      const found = candidates.find((c) => fitUnitsPx(exactOf(c), fontPx) !== fitUnitsPx(exactOf(c), 44 / 3));
      expect(found, 'no label whose fitted width moves with the size: the check is vacuous').toBeDefined();
      return found!;
    };
    const label = pick((t) => textExactPx(t, 12, 400), 12);
    const at = fitUnitsPx(textExactPx(label, 12, 400), 12);
    expect(labelLineCount(label, null, 400, at, 0)).toBe(1);
    expect(labelLineCount(label, null, 400, at - 1 / 128, 0)).toBe(2);
    const tile = { label, trendFootnote: null, figure: { value: 1 }, delta: null, sparklineSvg: null } as unknown as KpiTile;
    expect(kpiTileLines(tile, at).label).toBe(1);
    expect(kpiTileLines(tile, at - 1 / 128).label).toBe(2);
    const heading = pick((t) => headingLineExactPx(t), HEADING_PX);
    const hat = fitUnitsPx(headingLineExactPx(heading), HEADING_PX);
    expect(headingLineCount(heading, undefined, hat, 0)).toBe(1);
    expect(headingLineCount(heading, undefined, hat - 1 / 128, 0)).toBe(2);
  });
});
