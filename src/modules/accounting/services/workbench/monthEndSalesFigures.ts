/**
 * The receivables and payables figures on the Month-End "Sales & Receivables"
 * and "Supplier Bills & Payments" cards.
 *
 * "Current" and "past" are about the calendar only: a period is current when
 * its last day is today or later, past when it is before today. fiscal_periods
 * (whether the books are locked) is deliberately never read; do not wire it in.
 *
 * Current period: the headline figure (reports/headlineFigures), the aged
 * debtors / creditors open book as at TODAY (reports/dashboardOpenBook#getOpenBook),
 * the figure /accounting and /home show. Ageing a current month "as at" its
 * future last day would count every invoice due between today and then as
 * overdue, a debt nobody can chase yet. `overdue` includes disputed balances, as
 * the dashboard tile's does.
 *
 * Past period: a historical fact, so the aged report rewound to the period end.
 * Its overdue leaves disputes out of the age buckets (sumAging). The card links
 * to the aged report at the same date so the drill-down matches.
 *
 * `asAt` is the date the figures are stated at: today, or the period end.
 */

import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getOpenBook } from '@/modules/accounting/services/reports/dashboardOpenBook';
import { todayInSast } from '@/lib/saDateParser';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

export interface SalesFigures {
  overdue: number;
  total: number;
  /** Customers (sales) or suppliers (purchases) behind `total`. */
  parties: number;
  /** The period ended before today: the figures are the aging rewound to its end. */
  past: boolean;
  /** YYYY-MM-DD the figures are stated at: today (current period) or the period end (past). */
  asAt: string;
}

export function sumAging(buckets: AgingBucket[]): { total: number; overdue: number } {
  let total = 0;
  let overdue = 0;
  for (const b of buckets) {
    const cur = Number(b.current) || 0;
    const late = (Number(b.days30) || 0) + (Number(b.days60) || 0) + (Number(b.days90) || 0) + (Number(b.days120Plus) || 0);
    // A disputed amount is still owed: it is in the total (as on the Aged Debtors screen), held outside the age buckets,
    // so it is not counted as overdue here (nor in the current-period path's overdue amount).
    total += cur + late + (Number(b.disputed) || 0);
    overdue += late;
  }
  return { total, overdue };
}

async function currentFigures(companyId: string, side: 'ar' | 'ap', today: string): Promise<SalesFigures> {
  const book = await getOpenBook(companyId, side, today);
  return { total: book.total, overdue: book.overdue, parties: book.parties, past: false, asAt: today };
}

export async function getSalesFigures(companyId: string, periodEnd: string, today: string = todayInSast()): Promise<SalesFigures> {
  if (periodEnd < today) {
    const buckets = await getARAging(companyId, periodEnd);
    return { ...sumAging(buckets), parties: buckets.length, past: true, asAt: periodEnd };
  }
  return currentFigures(companyId, 'ar', today);
}

export async function getPurchasesFigures(companyId: string, periodEnd: string, today: string = todayInSast()): Promise<SalesFigures> {
  if (periodEnd < today) {
    const buckets = await getAPAging(companyId, periodEnd);
    return { ...sumAging(buckets), parties: buckets.length, past: true, asAt: periodEnd };
  }
  return currentFigures(companyId, 'ap', today);
}
