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
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

function month(label: string, expenses: number): PackTrendPoint {
  return {
    month: `2026-${label}`,
    label,
    partial: false,
    daysCovered: 31,
    daysInMonth: 31,
    revenue: 10_000,
    otherIncome: 0,
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
    const matters = creditMonthMatters([month('06', 40_000), month('07', -2_372_753.88)], PACK_SCALE);
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
   * the month's revenue AND OTHER INCOME — the two income bands, not turnover
   * alone. The row said "larger by the month's revenue" and was wrong by the
   * other-income band on the demo company and wrong in DIRECTION on
   * Brightsphere, whose April turnover is negative; see the case below.
   *
   * Asserted on the trend ROW rather than on the two rendered strings,
   * because that is where the identity lives: both pages read one
   * `PackTrendPoint`, so a change that broke the relation would have to break
   * `revenue − expenses = netProfit` first. And the row says which is which,
   * which is the half a reader needs.
   */
  it('quantifies the CREDIT, and says so, where the panel quantifies the result', () => {
    const july = month('07', -1_869_169.85);
    const point = {
      ...july,
      revenue: 36_679.05,
      otherIncome: 2_000,
      netProfit: 36_679.05 + 2_000 - july.expenses,
    };
    const matters = creditMonthMatters([point], PACK_SCALE);
    expect(matters[0]!.quantum).toBe(1_869_169.85);
    // The panel's figure, from the same row.
    // Float, so the assertion is to the cent — the pack prints R'000.
    expect(point.netProfit).toBeCloseTo(1_907_848.90, 2);
    // And the whole of the difference is the month's revenue AND other
    // income. Turnover alone leaves the other-income band unaccounted for,
    // which is exactly what the printed sentence used to claim.
    expect(point.netProfit - matters[0]!.quantum!)
      .toBeCloseTo(point.revenue + point.otherIncome, 2);
    expect(point.netProfit - matters[0]!.quantum!).not.toBeCloseTo(point.revenue, 2);
    // The row names its own quantity, so the two are legible side by side.
    expect(matters[0]!.issue).toContain('The quantum is that credit');
    expect(matters[0]!.issue).toMatch(/net profit/);
  });

  it('is not invented for a month that simply spent little', () => {
    expect(creditMonthMatters([month('06', 1), month('07', 0)], PACK_SCALE)).toEqual([]);
  });

  /**
   * A page cannot print "every check ran clean" above a matter. The clean
   * line is itself a `PackMatter` (§7.1 criterion 3 — an empty result is
   * never an empty page), so adding a derived one has to take it away.
   */
  it('replaces the "every check ran clean" line rather than sitting under it', () => {
    const merged = withDerivedMatters([CLEAN], [month('07', -500)], PACK_SCALE);
    expect(merged.map((m) => m.kind)).toEqual(['finding']);
  });

  it('leaves a clean pack clean', () => {
    expect(withDerivedMatters([CLEAN], [month('07', 500)], PACK_SCALE)).toEqual([CLEAN]);
  });
});

/**
 * THE SENTENCE THE ROW PRINTS, HELD TO THE FIGURES IT PRINTS.
 *
 * The row said: "The quantum is that credit; the trends panel plots the
 * month's net profit, which is larger by the month's revenue." It was false
 * on both companies the pack is rendered against.
 *
 *   Demo, Jul 2026:  credit 1 869, net profit 1 908, difference 39 — but
 *                    turnover is 37. It omitted other income of 2.
 *   Brightsphere, Apr 2026: credit 4 128, net profit (1 408). The difference
 *                    is (5 536): net profit is LOWER than the credit, and the
 *                    month's turnover is NEGATIVE 5 535. Wrong in magnitude
 *                    and in direction, on the page before the sheet that
 *                    disproves it.
 *
 * The identity that actually holds is `netProfit = credit + revenue +
 * otherIncome`, because `getPackTrend` defines a month's net profit as every
 * revenue account less every expense account. So the row states its three
 * figures and this reads them back OFF THE PRINTED STRING and adds them —
 * a relation stated in words cannot be footed, and a relation stated in words
 * is what was wrong.
 */
describe('the credit-month sentence', () => {
  /** Every bracketed or bare figure the sentence prints, in order, as
   *  numbers — the arithmetic a director takes off the row. */
  function figuresIn(sentence: string): number[] {
    return [...sentence.matchAll(/\(?(\d[\d ]*(?:\.\d+)?)\)?/g)]
      .filter((m) => /[\d]/.test(m[1]!))
      .map((m) => {
        const value = Number(m[1]!.replace(/ /g, ''));
        return m[0]!.startsWith('(') ? -value : value;
      });
  }

  const cases = [
    // The live demo company's July: a small positive turnover and a small
    // other-income band. The band is the whole of what the old sentence lost.
    { name: 'positive turnover with other income', revenue: 37_000, otherIncome: 2_000, expenses: -1_869_000 },
    // Brightsphere's April: turnover in net DEBIT, so net profit lands BELOW
    // the credit. "larger by" was wrong in sign here.
    { name: 'negative turnover', revenue: -5_535_000, otherIncome: -1_000, expenses: -4_128_000 },
    // The case the old sentence was accidentally right about, kept so the fix
    // is not a fix for one company.
    { name: 'no other income at all', revenue: 41_000, otherIncome: 0, expenses: -900_000 },
  ] as const;

  for (const c of cases) {
    it(`states three figures that add, on a month with ${c.name}`, () => {
      const point: PackTrendPoint = {
        ...month('04', c.expenses),
        revenue: c.revenue,
        otherIncome: c.otherIncome,
        netProfit: c.revenue + c.otherIncome - c.expenses,
      };
      const [matter] = creditMonthMatters([point], PACK_SCALE);
      // The label, then credit, net profit, income — in the order printed.
      const figures = figuresIn(matter!.issue.replace(/^\S+:/, ''));
      expect(figures).toHaveLength(3);
      const [credit, netProfit, income] = figures as [number, number, number];
      // At R'000, which is what the row prints in.
      expect(credit).toBe(Math.round(Math.abs(c.expenses) / 1_000));
      expect(netProfit).toBe(Math.round(point.netProfit / 1_000));
      // THE ADDITION THE SENTENCE CLAIMS. Restore "larger by the month's
      // revenue" — drop `otherIncome` from `incomeOf` — and the first case
      // goes red by 2 and the second by 1.
      expect(credit + income).toBe(netProfit);
      // And the sentence says it is an addition, never a comparison of size.
      expect(matter!.issue).toContain('is that credit plus ');
      expect(matter!.issue).not.toMatch(/larger by/);
    });
  }
});
