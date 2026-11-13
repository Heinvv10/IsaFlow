/**
 * T3: vatPeriodOf for all 12 months × {monthly, odd, even} equals the periods
 * vatPeriodHelper.vatQuickPeriods produces (the oracle; 'odd' = periods ENDING
 * in odd months, SARS Category A). Plus due / refund months.
 */
import { describe, it, expect } from 'vitest';
import { vatQuickPeriods, type VatAlignment, type VatCadence } from '@/modules/bureau/services/vatPeriodHelper';
import {
  vatPeriodOf, vatDueMonth, vatSettleMonth,
} from '@/modules/accounting/services/budgets/threeWay/vatSchedule';

const CASES: Array<[VatCadence, VatAlignment]> = [['monthly', 'odd'], ['bi-monthly', 'odd'], ['bi-monthly', 'even']];

describe('vatPeriodOf matches vatQuickPeriods', () => {
  for (const year of [2026, 2028]) {
    for (const [cadence, alignment] of CASES) {
      it(`${year} ${cadence} ${alignment}: every month`, () => {
        const oracle = [...vatQuickPeriods(year, cadence, alignment), ...vatQuickPeriods(year + 1, cadence, alignment)];
        for (let mo = 1; mo <= 12; mo++) {
          const month = `${year}-${String(mo).padStart(2, '0')}`;
          const hit = oracle.find(p => p.from.slice(0, 7) <= month && p.to.slice(0, 7) >= month);
          expect(hit, month).toBeDefined();
          expect([month, vatPeriodOf(month, cadence, alignment)])
            .toEqual([month, { start: hit?.from.slice(0, 7), end: hit?.to.slice(0, 7) }]);
        }
      });
    }
  }
  it('monthly ignores alignment', () => {
    expect(vatPeriodOf('2026-04', 'monthly', 'even')).toEqual({ start: '2026-04', end: '2026-04' });
  });
});

describe('due and refund months', () => {
  it('payable due the month after the period end; refund at end + lag', () => {
    const p = { start: '2026-11', end: '2026-12' };
    expect(vatDueMonth(p)).toBe('2027-01');
    expect(vatSettleMonth(p, 100, 1)).toBe('2027-01');
    expect(vatSettleMonth(p, 0, 2)).toBe('2027-01');
    expect(vatSettleMonth(p, -100, 0)).toBe('2026-12');
    expect(vatSettleMonth(p, -100, 2)).toBe('2027-02');
  });
});

describe('rate', () => {
  it('the engine rate equals the reports module SA rate', async () => {
    const { SA_VAT_RATE } = await import('@/modules/accounting/services/reports/vatBoxBasis');
    const { SA_STANDARD_RATE_BP } = await import('@/modules/accounting/services/budgets/threeWay/ratios');
    expect(SA_STANDARD_RATE_BP).toBe(Math.round(SA_VAT_RATE * 10000));
  });
});
