/**
 * THE MONTH THE MATTERS PAGE COULD NOT SEE.
 *
 * The rendered demo pack drew net profit of +1 908 R'000 for July 2026 in a
 * company reporting R100k of revenue for the whole period, and its own panel
 * said the month's expenses were a net credit — while page 11, the page a
 * board pack exists for, said nothing about it. The cause was seven payroll
 * journals dated 2031 reversed into July, and every check feeding page 11
 * misses that by construction: `getUnusualJournals` selects on `entry_date
 * BETWEEN` the reporting window, so the 2031 originals are not in the result
 * set, and it flags an entry only when it was RECORDED WELL AFTER its entry
 * date — a reversal dated and posted in the same July is neither late nor a
 * round number.
 *
 * So the anomaly is derived from the series the pack already draws. This
 * holds it to both directions: a credit month becomes a matter, and a normal
 * month does not become one.
 */
import { describe, expect, it } from 'vitest';
import { withDerivedMatters, creditMonthMatters } from '@/modules/accounting/services/packs/pages/packDerivedMatters';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

function month(label: string, expenses: number): PackTrendPoint {
  return {
    month: `2026-${label}`,
    label,
    revenue: 10_000,
    expenses,
    netProfit: 10_000 - expenses,
    costOfSales: 0,
    operatingExpenses: expenses,
    grossMarginPct: 100,
    cash: -100,
    accountsReceivable: 0,
    debtorDays: 0,
  };
}

const CLEAN: PackMatter = {
  kind: 'none',
  issue: 'No matters require board attention this period — every check ran clean.',
  quantum: null,
  owner: 'Finance',
  movement: 'Not tracked.',
  decisionRequired: 'None. Note for the record.',
};

describe('a month whose expenses are a net credit', () => {
  it('becomes a matter, carrying the size of the credit', () => {
    const matters = creditMonthMatters([month('06', 40_000), month('07', -2_372_753.88)]);
    expect(matters).toHaveLength(1);
    expect(matters[0]!.issue).toContain('07');
    expect(matters[0]!.issue).toContain('net credit');
    expect(matters[0]!.quantum).toBe(2_372_753.88);
    // A decision, not an observation — the column is called Decision required.
    expect(matters[0]!.decisionRequired).toMatch(/reversals/i);
  });

  /**
   * TWO NUMBERS FOR ONE MONTH, AND THE ROW HAS TO SAY WHICH IS WHICH.
   *
   * The rendered demo pack quantified July at 1 908 on sheet 10 and at 1 869
   * on sheet 11, and a reader meeting both takes them for one quantity stated
   * twice — the defect class this pack has fixed four times. They are two
   * quantities: `dominantPoint` gives the panel the month's NET PROFIT and
   * this matter's quantum is the EXPENSE CREDIT alone, so the difference is
   * the month's revenue exactly. 1 907 848.90 − 1 869 169.85 = 38 679.05,
   * which is July's revenue to the cent on the live company.
   *
   * Asserted on the trend ROW rather than on the two rendered strings,
   * because that is where the identity lives: both pages read one
   * `PackTrendPoint`, so a change that broke the relation would have to break
   * `revenue − expenses = netProfit` first. And the row says which is which,
   * which is the half a reader needs.
   */
  it('quantifies the CREDIT, and says so, where the panel quantifies the result', () => {
    const july = month('07', -1_869_169.85);
    const point = { ...july, revenue: 38_679.05, netProfit: 38_679.05 - july.expenses };
    const matters = creditMonthMatters([point]);
    expect(matters[0]!.quantum).toBe(1_869_169.85);
    // The panel's figure, from the same row.
    // Float, so the assertion is to the cent — the pack prints R'000.
    expect(point.netProfit).toBeCloseTo(1_907_848.90, 2);
    // And the whole of the difference is the month's revenue.
    expect(point.netProfit - matters[0]!.quantum!).toBeCloseTo(point.revenue, 2);
    // The row names its own quantity, so the two are legible side by side.
    expect(matters[0]!.issue).toContain('The quantum is that credit');
    expect(matters[0]!.issue).toMatch(/net profit/);
  });

  it('is not invented for a month that simply spent little', () => {
    expect(creditMonthMatters([month('06', 1), month('07', 0)])).toEqual([]);
  });

  /**
   * A page cannot print "every check ran clean" above a matter. The clean
   * line is itself a `PackMatter` (§7.1 criterion 3 — an empty result is
   * never an empty page), so adding a derived one has to take it away.
   */
  it('replaces the "every check ran clean" line rather than sitting under it', () => {
    const merged = withDerivedMatters([CLEAN], [month('07', -500)]);
    expect(merged.map((m) => m.kind)).toEqual(['finding']);
  });

  it('leaves a clean pack clean', () => {
    expect(withDerivedMatters([CLEAN], [month('07', 500)])).toEqual([CLEAN]);
  });
});
