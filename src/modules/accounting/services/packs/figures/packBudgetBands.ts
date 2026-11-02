/**
 * Page 6's income-statement rows and the tracking engine's band or profit total each one prints
 * in the Budget column (budgets P3 PR-E). Pure: the figure set reads by it, the table builder
 * labels its budget sources by it, and neither needs the other loaded to know it.
 */
import type { TrackingBandKey, TrackingTotalKey } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

/** The income statement rows (page 6 keys) and the engine band or profit total each one prints. */
export const PACK_BUDGET_BAND = {
  'is.revenue': 'turnover',
  'is.costOfSales': 'cost_of_sales',
  'is.grossProfit': 'gross_profit',
  'is.operatingExpenses': 'operating_expense',
  'is.otherIncome': 'other_income',
  'is.operating': 'operating_profit',
  'is.otherExpenses': 'other_expense',
  'is.netProfit': 'net_profit',
} as const satisfies Record<string, TrackingBandKey | TrackingTotalKey>;

export type PackBudgetRowKey = keyof typeof PACK_BUDGET_BAND;
