/**
 * `packFigureFit.ts`: whether a row of figures fits the sheet, and at what whole-pixel size. The proof that the
 * decision matches Chromium at its thresholds is `tests/unit/print/packFigureFitThreshold.test.ts`; this holds the
 * logic around it.
 */
import { describe, expect, it } from 'vitest';
import {
  fitAttributes, HEADING_WORD_PX, kpiColumnMinPx, kpiFit, tableColumnCells, tableFit,
} from '@/modules/accounting/services/packs/pages/packFigureFit';
import { demoWithoutBudget, SCALE, withWidenedKpi, withWidenedTable } from './fixtures/widenedFigures';

describe('tableFit', () => {
  it('sets nothing for the demo company\'s table: it fits at the ordinary size', () => {
    const { table } = withWidenedTable(demoWithoutBudget(), 6);
    expect(tableFit(table, SCALE)).toEqual({ px: null, fits: true });
    expect(fitAttributes(tableFit(table, SCALE))).toEqual({});
  });

  it('steps down from 12px to the 10px floor as the figures widen, whole pixels only', () => {
    const sizes = Array.from({ length: 24 }, (unused, i) => i + 6).map((d) => tableFit(withWidenedTable(demoWithoutBudget(), d).table, SCALE));
    const px = sizes.filter((f) => f.fits).map((f) => f.px ?? 12);
    expect(px).toEqual([...px].sort((a, b) => b - a));
    expect(Math.min(...px)).toBe(10);
    expect(new Set(px).has(12) && new Set(px).has(10)).toBe(true);
    expect(sizes.some((f) => !f.fits)).toBe(true);
  });

  it('a column heading and its marker are a floor for the column: a heading wider than its figures sets the width', () => {
    expect(HEADING_WORD_PX.monthOperatingExpenses).toBeGreaterThan(HEADING_WORD_PX.prior);
    const { table } = withWidenedTable(demoWithoutBudget(), 6);
    const narrow = { ...table, columns: ['prior'] as const, rows: table.rows.map((r) => ({ ...r, figures: { prior: { ...r.figures.actual!, value: 1000 } } })) };
    const marked = { ...narrow, columnNotes: [{ column: 'prior' as const, footnote: 2 }] };
    expect(tableFit(narrow, SCALE).fits && tableFit(marked, SCALE).fits).toBe(true);
  });

  it('a not-meaningful cell is charged as "n/m" and its mark', () => {
    const { table } = withWidenedTable(demoWithoutBudget(), 6);
    const nm = { ...table, rows: table.rows.map((r) => ({ ...r, figures: { actual: { ...r.figures.actual!, value: null, unavailable: 'x' } } })) };
    expect(tableColumnCells(nm, SCALE)[0]!.every((c) => c.text === 'n/m a')).toBe(true);
  });

  it('a derived cell of a row whose actual is not meaningful is measured as the "n/m" the table prints, not as a dash', () => {
    const { table } = withWidenedTable(demoWithoutBudget(), 6);
    const row = table.rows[0]!;
    const half = {
      ...table, columns: ['actual', 'prior'] as const,
      rows: [{ ...row, figures: { actual: { ...row.figures.actual!, value: null, unavailable: 'no base' } } }, { ...table.rows[1]!, figures: { actual: table.rows[1]!.figures.actual!, prior: table.rows[1]!.figures.actual! } }],
    };
    const [actual, prior] = tableColumnCells(half, SCALE);
    expect(actual![0]!.text).toBe('n/m a');
    expect(prior![0]!.text, 'the prior cell of that row prints n/m').toBe('n/m a');
    expect(prior![1]!.text, 'a row with its own prior prints it').not.toBe('n/m a');
  });

  it('weights follow the row role: subtotal 500, total and grand total 600, a line 400', () => {
    const { table } = withWidenedTable(demoWithoutBudget(), 6);
    const weights = new Map(table.rows.map((r) => [r.role, tableColumnCells(table, SCALE)[0]![table.rows.indexOf(r)]!.weight]));
    expect(weights.get('line')).toBe(400);
    expect(weights.get('subtotal')).toBe(500);
    expect([weights.get('total'), weights.get('grandTotal')].filter((w) => w !== undefined).every((w) => w === 600)).toBe(true);
  });
});

describe('kpiFit', () => {
  it('sets nothing for the demo company\'s tiles', () => {
    const { tiles } = withWidenedKpi(demoWithoutBudget(), 6);
    expect(kpiFit(tiles, SCALE)).toEqual({ px: null, fits: true });
  });

  it('puts tile i in column i % 4 and takes the widest of each column', () => {
    const { tiles } = withWidenedKpi(demoWithoutBudget(), 6);
    const widest = kpiColumnMinPx(tiles, SCALE, 20);
    expect(widest).toHaveLength(4);
    expect(widest.every((w) => w > 0)).toBe(true);
    const wider = kpiColumnMinPx(withWidenedKpi(demoWithoutBudget(), 9).tiles, SCALE, 20);
    expect(wider[0]).toBeGreaterThan(widest[0]!);
  });

  it('steps down from the ordinary size toward the 16px floor, then does not fit', () => {
    const sizes = Array.from({ length: 24 }, (unused, i) => i + 6).map((d) => kpiFit(withWidenedKpi(demoWithoutBudget(), d).tiles, SCALE));
    const px = sizes.filter((f) => f.fits).map((f) => f.px ?? 29.33);
    expect(px).toEqual([...px].sort((a, b) => b - a));
    expect(Math.min(...px)).toBeGreaterThanOrEqual(16);
    expect(Math.min(...px)).toBeLessThan(29);
    expect(px.every((v) => Number.isInteger(v) || v === 29.33)).toBe(true);
    expect(sizes.some((f) => !f.fits)).toBe(true);
  });
});

describe('fitAttributes', () => {
  it('a fitted row carries the class and the size; a row that fits carries neither', () => {
    expect(fitAttributes({ px: 11, fits: true })).toEqual({ className: 'is-fitted', style: { '--pack-fit-size': '11px' } });
    expect(fitAttributes({ px: null, fits: true })).toEqual({});
  });
});
