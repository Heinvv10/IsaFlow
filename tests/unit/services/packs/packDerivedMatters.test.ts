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
