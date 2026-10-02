/**
 * THE DASHBOARD'S MARGIN FIGURES ARE NULL WHERE THE ENGINE SAYS THERE IS NO MARGIN.
 *
 * `buildExecutiveSummary` computed `kpis.grossProfitMargin` and
 * `netProfitMargin` with its own `pct`, which answers 0 on nil revenue and a
 * sign-flipped figure on negative revenue — so the executive dashboard's
 * accountant view printed "Gross margin 0.0%" for a dormant company and a
 * positive margin for one whose credit notes exceeded its sales, beside a
 * KPI scorecard saying the same ratio had no meaning. They now come from the
 * ratio engine, null with its reason in `kpis.notMeaningful`.
 */
import { describe, expect, it } from 'vitest';
import { buildExecutiveSummary, type ExecutiveSummaryInput } from '@/modules/accounting/services/reports/executiveSummaryService';

const INPUT: ExecutiveSummaryInput = {
  period: '2026-01-01 to 2026-09-07', companyName: 'Demo',
  revenue: 101_400, costOfSales: 1_430_581.6, operatingExpenses: 215_059.3, netProfit: -1_544_240.9,
  totalAssets: 900_000, totalLiabilities: 1_300_000, totalEquity: -400_000,
  currentAssets: 140_000, currentLiabilities: 1_000_000, cash: 20_000,
  accountsReceivable: 58_000, accountsPayable: 300_000, inventory: 0,
};
const REVENUE = 'Revenue is not positive, so this ratio has no meaning.';

describe.each([
  ['negative revenue', { revenue: -5_535_000, costOfSales: 0, netProfit: -6_400_000 }],
  ['nil revenue', { revenue: 0, costOfSales: 0, netProfit: -910_000 }],
])('on %s', (_name, over) => {
  const { kpis } = buildExecutiveSummary({ ...INPUT, ...over }, '2026-01-01', '2026-09-07');

  it('carries no margin — not 0, and not a sign-flipped one', () => {
    expect(kpis.grossProfitMargin).toBeNull();
    expect(kpis.netProfitMargin).toBeNull();
  });

  it('carries the engine\'s reason for each', () => {
    expect(kpis.notMeaningful).toEqual({ grossProfitMargin: REVENUE, netProfitMargin: REVENUE });
  });
});

describe('on positive revenue', () => {
  it('carries the true margins, negative ones included, and no reasons', () => {
    const { kpis } = buildExecutiveSummary(INPUT, '2026-01-01', '2026-09-07');
    expect(kpis.grossProfitMargin).toBe(-1310.83);
    expect(kpis.netProfitMargin).toBe(-1522.92);
    expect(kpis.notMeaningful).toEqual({});
  });
});
