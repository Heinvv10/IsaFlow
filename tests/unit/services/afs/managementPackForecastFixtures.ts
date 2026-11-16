/**
 * A three-way view (budgets P6, `getThreeWay`) as the pack's cash flow forecast reads it: only the fields the
 * section uses are filled; the rest of the view is irrelevant to it. Money in integer cents.
 */
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
/** Closing cash per month: lowest in 2026-12 (R 2 000.00), below the R 5 000.00 minimum from 2026-11. */
const CLOSING = [900_000, 880_000, 860_000, 840_000, 820_000, 800_000, 700_000, 600_000, 400_000, 200_000, 350_000, 600_000];

export function threeWayView(over: Partial<ThreeWayView> = {}): ThreeWayView {
  return {
    version: { id: 'v-1', name: 'Original 2027', kind: 'original', status: 'approved', fiscalYear: 2027, isPrimary: true, basedOnVersionId: null },
    months: MONTHS,
    opening: { asAt: '2026-02-28', provisional: false },
    cashFlow: {
      direct: MONTHS.map((month, i) => ({ month, closingCash: CLOSING[i] as number })),
      indirect: [],
    },
    runway: { minimumCash: 500_000, firstBelowMinimum: '2026-11', minCash: 200_000, minCashMonth: '2026-12' },
    checks: { balanced: true, unbalancedMonths: [], openingCash: { difference: 0, accounts: [] } },
    warnings: [{ code: 'opening_excess_spread', series: 'receivables', days: 120, excess: 1_234_500, months: 3 }],
    ...over,
  } as unknown as ThreeWayView;
}
