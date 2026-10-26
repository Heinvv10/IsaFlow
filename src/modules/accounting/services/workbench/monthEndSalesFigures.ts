/**
 * The receivables and payables figures on the Month-End "Sales & Receivables"
 * and "Supplier Bills & Payments" cards.
 *
 * "Current" and "past" are about the calendar only: a period is current when
 * its last day is today or later, past when it is before today. fiscal_periods
 * (whether the books are locked) is deliberately never read; do not wire it in.
 *
 * Sales, current period: the shared AR aggregate (getAROutstandingWithDebtors, the
 * figure the dashboard and the invoice-list tiles read), with the customer count
 * from the same population (debtorCount, same query). Ageing a current month "as at"
 * its future last day would count every invoice due between today and then as
 * overdue, a debt nobody can chase yet (dev Demo, Oct 2026: 32 invoices,
 * R 3 680.00 above the tile).
 *
 * Sales, past period: a historical fact the aggregate cannot answer, so the aged
 * debtors report rewound to the period end. That report is defined differently
 * from the aggregate (it takes open disputes out of the buckets and leaves out
 * invoices dated after the as-at date), so a past period can differ from what
 * the same card showed while the period was current. The card links to the aged
 * debtors report at the same date so the drill-down matches.
 *
 * Purchases equals the AP aging report as at today (or at the period end for a
 * past period), NOT the dashboard AP tile: no shared AP aggregate exists.
 */

import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAROutstandingWithDebtors } from '@/modules/accounting/services/ar/arOutstandingService';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

export interface SalesFigures {
  overdue: number;
  total: number;
  /** Customers (sales) or suppliers (purchases) behind `total`. */
  parties: number;
  /** The period ended before today: the figures are the aging rewound to its end. */
  past: boolean;
}

export function sumAging(buckets: AgingBucket[]): { total: number; overdue: number } {
  let total = 0;
  let overdue = 0;
  for (const b of buckets) {
    const cur = Number(b.current) || 0;
    const late = (Number(b.days30) || 0) + (Number(b.days60) || 0) + (Number(b.days90) || 0) + (Number(b.days120Plus) || 0);
    total += cur + late;
    overdue += late;
  }
  return { total, overdue };
}

export async function getSalesFigures(companyId: string, periodEnd: string, today: string = asAtTodayStr()): Promise<SalesFigures> {
  if (periodEnd < today) {
    const buckets = await getARAging(companyId, periodEnd);
    return { ...sumAging(buckets), parties: buckets.length, past: true };
  }
  const summary = await getAROutstandingWithDebtors(companyId);
  return { overdue: summary.overdueAmount, total: summary.outstanding, parties: summary.debtorCount, past: false };
}

export async function getPurchasesFigures(companyId: string, periodEnd: string, today: string = asAtTodayStr()): Promise<SalesFigures> {
  const past = periodEnd < today;
  const buckets = await getAPAging(companyId, past ? periodEnd : today);
  return { ...sumAging(buckets), parties: buckets.length, past };
}
