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
import { keptLayouts, LAYOUTS_MAX, statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { CELL_SIDE_PX, ROW_WEIGHT } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { textExactPx, textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { fitUnitsPx } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { WRAP_GUARD } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { input, type Shape } from './fixtures/packGridInputs';

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

describe('a layout is kept by what the table holds', () => {
  it('the same table gives the same layout once computed; a table edited in place is laid out afresh', () => {
    const table = incomeTable(BASE);
    const first = tableLayout(table, SCALE, 'portrait');
    expect(tableLayout(structuredClone(table), SCALE, 'portrait')).toBe(first);
    expect(Object.isFrozen(first.labelLines) && Object.isFrozen(first.columnsPx)).toBe(true);
    const lines = first.labelLines[0]!;
    table.rows[0] = { ...table.rows[0]!, label: `${table.rows[0]!.label} and a great many more words than the column holds on one line` };
    expect(tableLayout(table, SCALE, 'portrait').labelLines[0]).toBeGreaterThan(lines);
    expect(tableLayout(table, SCALE, 'landscape')).not.toBe(tableLayout(table, SCALE, 'portrait'));
  });

  it(`keeps at most ${LAYOUTS_MAX} layouts, dropping the least recently used`, () => {
    const table = incomeTable(BASE);
    const kept = tableLayout(table, SCALE, 'portrait');
    const variant = (n: number) => ({ ...table, rows: table.rows.map((r, i) => (i === 0 ? { ...r, label: `Revenue ${n}` } : r)) });
    const first = tableLayout(variant(0), SCALE, 'portrait');
    for (let n = 1; n <= LAYOUTS_MAX + 50; n += 1) {
      tableLayout(variant(n), SCALE, 'portrait');
      // Used throughout, so never the least recent.
      expect(tableLayout(table, SCALE, 'portrait')).toBe(kept);
    }
    expect(keptLayouts()).toBe(LAYOUTS_MAX);
    expect(tableLayout(variant(0), SCALE, 'portrait'), 'the least recently used was dropped').not.toBe(first);
    expect(tableLayout(variant(0), SCALE, 'portrait')).toEqual(first);
  });

  it('is kept by what the table prints: the same figures under another source share a layout', () => {
    const table = incomeTable(BASE);
    const resourced = { ...table, rows: table.rows.map((r) => ({ ...r, key: `${r.key ?? ''}-x`, figures: Object.fromEntries(Object.entries(r.figures).map(([c, f]) => [c, f && { ...f, source: `${f.source}.x` }])) })) };
    expect(tableLayout(resourced as typeof table, SCALE, 'portrait')).toBe(tableLayout(table, SCALE, 'portrait'));
  });
});

describe('whether a label line still holds a piece is decided as Chromium\'s line breaker decides it', () => {
  // The line's exact advance sum floored to the unit (`fitUnitsPx`), against the column less the guard: a label whose two
  // words fit at that width takes one line, and one a unit too wide for it takes two. The never-short width (one unit
  // more, the exact sum rounded up) would wrap the first: Chromium does not (`tests/unit/print/packLineFit.test.ts`).
  it('a label whose two words fit their column at the floored exact width takes one line; at the never-short width it would wrap', () => {
    const base = incomeTable(BASE);
    const row = base.rows.findIndex((r) => r.level === 0 && r.role === 'line' && r.footnote === undefined);
    const weight = ROW_WEIGHT[base.rows[row]!.role];
    let found = 0;
    for (let a = 1; a <= 24 && found === 0; a += 1) for (let n = 1; n <= 24 && found === 0; n += 1) {
      for (const tail of ['i', 'l', 'j', 'f', 't', 'r']) {
        const label = `${'m'.repeat(a)} ${'m'.repeat(n)}${tail}`;
        const table = { ...base, rows: base.rows.map((r, i) => (i === row ? { ...r, label } : r)) };
        const layout = tableLayout(table, SCALE, 'portrait');
        const avail = layout.columnsPx[0]! - CELL_SIDE_PX - WRAP_GUARD.portrait;
        if (fitUnitsPx(textExactPx(label, 12, weight), 12) <= avail && textPx(label, 12, weight) > avail) {
          found += 1;
          expect(layout.labelLines[row], `"${label}" fits at its floored exact width`).toBe(1);
        }
      }
    }
    expect(found, 'no label at the unit boundary: the test is vacuous').toBeGreaterThan(0);
  });
});

describe('a layout is kept by the columns that print', () => {
  // Both tables declare Actual, Prior and Budget; one has no Prior figure on any row, the other no Budget, and the
  // cells that print are the same text. A key on the declared columns and the cell texts makes them one table, and the
  // second gets the first's headings and widths (a blind review of #1187, M1).
  const fig = (value: number, source: string) => ({ value, format: 'money' as const, source });
  const table = (second: 'prior' | 'budget'): PackTable => ({
    scale: SCALE,
    columns: ['actual', 'prior', 'budget'],
    rows: [1, 2, 3].map((n) => ({ label: `Line ${n}`, level: 0, role: 'line' as const, figures: { actual: fig(n * 1000, `a${n}`), [second]: fig(n * 1000, `${second}${n}`) } })),
  });

  it('two tables whose surviving columns differ do not share a layout, though their cells print the same', () => {
    const withBudget = tableLayout(table('budget'), SCALE, 'portrait');
    const withPrior = tableLayout(table('prior'), SCALE, 'portrait');
    expect(withPrior).not.toBe(withBudget);
    expect(withPrior.columnsPx).not.toEqual(withBudget.columnsPx);
    // And each is its own table's, asked again.
    expect(tableLayout(table('budget'), SCALE, 'portrait')).toBe(withBudget);
    expect(tableLayout(table('prior'), SCALE, 'portrait')).toBe(withPrior);
  });
});
