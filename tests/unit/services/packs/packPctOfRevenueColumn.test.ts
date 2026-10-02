/**
 * RULE 2: NON-POSITIVE REVENUE MAKES THE "% OF REVENUE" COLUMN `n/m`, IT DOES
 * NOT DELETE IT — AND UNTIL NOW NOTHING HELD THAT.
 *
 * Brightsphere's sheet 6 silently lost a column the demo pack shows, which
 * reads as a pack with a different SHAPE rather than a company with negative
 * turnover. The fix is two halves — `columnsFor` declaring the column
 * whenever the statement has one, and `buildRow` filling every cell with a
 * null figure against `REVENUE_NOT_A_POSITIVE_BASE` — and it shipped with no
 * test of its own. `checkColumns` in `packStatementIntegrity.ts` refuses a
 * declared column no row carries and a carried column no table declared, so
 * it fails a HALF-revert in either direction; what it cannot see is both
 * halves going back together, because the pre-change state is self-consistent.
 * Each half was pinned only by the other, which is coupling, not coverage.
 *
 * So these assert the two shapes AGAINST EACH OTHER on the two live fixtures:
 * Brightsphere declares the column and every cell in it is a stated reason,
 * the demo pack declares the same column and its cells carry real
 * percentages. A test that only looked at one company would pass on the
 * reverted code, because on the reverted code the demo pack is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { REVENUE_NOT_A_POSITIVE_BASE } from '@/modules/accounting/services/packs/pages/packStatementTables';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';

/** Sheet 6's statement — the pack's one table with a "% of revenue" column. */
function incomeStatement(input: BoardPackInput): PackTable {
  const page = buildBoardPackPages(input).pages.find((p) => p.number === 6)!;
  return page.blocks.flatMap((b) => (b.kind === 'table' ? [b.table] : []))[0]!;
}

describe('the "% of revenue" column on a company with non-positive revenue', () => {
  it('is declared on Brightsphere, whose revenue is negative', () => {
    expect(brightsphereLiveInput.set.current.revenue).toBeLessThan(0);
    expect(incomeStatement(brightsphereLiveInput).columns).toContain('pctOfRevenue');
  });

  it('carries a stated reason in every cell of it, never an omitted cell', () => {
    const table = incomeStatement(brightsphereLiveInput);
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows) {
      const cell = row.figures.pctOfRevenue;
      // DEFINED, not merely null-valued: the renderer's fallback for a
      // declared column with no figure is the em dash, which this pack
      // defines as a figure MEASURED AND NIL — a share of nothing asserted
      // rather than a reason given.
      expect(cell, `${row.label} omits its % of revenue cell`).toBeDefined();
      expect(cell!.value, row.label).toBeNull();
      expect(cell!.unavailable, row.label).toBe(REVENUE_NOT_A_POSITIVE_BASE);
    }
  });

  it('names the CURRENT period\'s revenue as the base, not the prior figure', () => {
    expect(REVENUE_NOT_A_POSITIVE_BASE).toMatch(/Revenue for the period/);
    expect(REVENUE_NOT_A_POSITIVE_BASE).not.toMatch(/prior/i);
  });

  /**
   * THE DISCRIMINATING HALF. Reverting both halves of the fix leaves the demo
   * pack exactly as it is, so an assertion about Brightsphere alone could be
   * satisfied by a suite that never looked at a company with revenue. This
   * pins the other shape: the same column, on the same sheet, carrying
   * numbers.
   */
  it('carries real percentages on the demo company, whose revenue is positive', () => {
    expect(liveDemoRenderedInput.set.current.revenue).toBeGreaterThan(0);
    const table = incomeStatement(liveDemoRenderedInput);
    expect(table.columns).toContain('pctOfRevenue');
    const cells = table.rows.map((row) => row.figures.pctOfRevenue);
    expect(cells.every((c) => c !== undefined)).toBe(true);
    expect(cells.some((c) => typeof c!.value === 'number')).toBe(true);
    for (const cell of cells) {
      expect(cell!.unavailable).not.toBe(REVENUE_NOT_A_POSITIVE_BASE);
    }
    // The revenue row's own share of revenue is 100% where the base is usable
    // — the cheapest proof the column is computed against the right figure.
    const revenue = table.rows.find((row) => row.label === 'Revenue')!;
    expect(revenue.figures.pctOfRevenue!.value).toBeCloseTo(100, 6);
  });

  /**
   * RULE 1 IS GENUINELY DIFFERENT, and this is here so a later reader does not
   * "fix" the two into one: no comparative PERIOD means no prior, change or
   * change-% column at all, because there is no column to have a reason about.
   */
  it('still removes the comparative columns entirely where there is no prior period', () => {
    const table = incomeStatement({
      ...brightsphereLiveInput,
      set: { ...brightsphereLiveInput.set, prior: null },
    });
    expect(table.columns).toContain('pctOfRevenue');
    expect(table.columns).not.toContain('prior');
    expect(table.columns).not.toContain('change');
    expect(table.columns).not.toContain('changePct');
  });
});
