/**
 * THE FIT MODEL SEES THE WRAPS ON PAGE 6 OF A BUDGET COMPANY (the adversary's page 6 overflow).
 *
 * At k=1,000 the 8-column table (Actual, Prior, Change, Change %, Budget, Variance and the rest) gives its label
 * column 33mm, so "Operating expenses" wraps to two lines, and the Budget column is 1.2px narrower than its
 * heading, so the headings wrap to two lines: the table measures 77.5mm. The model charged 73.2. The Chromium
 * proof over a stratified sample is `tests/unit/print/packTableLayout.test.ts`; this pins the model's own
 * answer on the two shapes without a browser.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import { statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { input, type Shape } from './fixtures/advInputs';

const SCALE = "R'000" as const;

function incomeTable(shape: Shape): PackTable {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const page = buildBoardPackPages(input(shape)).pages.find((p) => p.navLabel === 'Income statement')!;
  const block = page.blocks.find((b) => b.kind === 'table')!;
  if (block.kind !== 'table') throw new Error('no table');
  return block.table;
}

const BASE: Shape = { tr: 'demo', budget: true, prior: true, negative: false, loss: true, k: 1000, plug: 0.05, sg: [1, 1, 1, 1] };

describe('page 6 of a budget company at k=1,000', () => {
  const table = incomeTable(BASE);
  const layout = tableLayout(table, SCALE, 'portrait');

  it('wraps "Operating expenses" to two lines and no other label', () => {
    const wrapped = table.rows.map((r, i) => [r.label, layout.labelLines[i]!] as const).filter(([, lines]) => lines > 1);
    expect(wrapped.map(([label]) => label)).toEqual(['Operating expenses']);
    expect(wrapped[0]![1]).toBe(2);
  });

  it('wraps the headings to two lines', () => {
    expect(layout.headingLines).toBe(2);
  });

  it('gives the label column about 126px and fills the 174mm sheet', () => {
    expect(layout.columnsPx[0]!).toBeGreaterThan(124);
    expect(layout.columnsPx[0]!).toBeLessThan(128);
    expect(layout.columnsPx.reduce((a, b) => a + b, 0)).toBeCloseTo(174 * (96 / 25.4), 0);
  });

  it('is 77.5mm tall, as Chromium sets it (it was modelled at 73.2)', () => {
    const mm = statementTableBodyMm(table, SCALE, 'portrait');
    expect(mm).toBeGreaterThanOrEqual(77.55);
    expect(mm).toBeLessThan(78.2);
  });
});

describe('page 6 of a budget company at k=1', () => {
  const table = incomeTable({ ...BASE, loss: false, k: 1 });
  const layout = tableLayout(table, SCALE, 'portrait');

  it('wraps nothing, so the table is its caption, one heading line and its rows', () => {
    expect(layout.labelLines.every((lines) => lines === 1)).toBe(true);
    expect(layout.headingLines).toBe(1);
    const mm = statementTableBodyMm(table, SCALE, 'portrait');
    expect(mm).toBeGreaterThanOrEqual(68.73);
    expect(mm).toBeLessThan(69.5);
  });
});
