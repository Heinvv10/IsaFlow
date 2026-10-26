/**
 * The receivables figures on the Month-End "Sales & Receivables" card.
 *
 * An OPEN period (its end is today or later) reads the shared AR aggregate, the
 * one the dashboard and the invoice-list tiles read, so the card cannot drift
 * from them. Ageing an open month "as at" its future last day instead counts
 * every invoice due between today and then as overdue, a debt nobody can chase
 * yet (dev Demo, Oct 2026: 32 invoices, R 3 680.00 above the tile).
 *
 * A CLOSED period (its end is in the past) is a historical fact the aggregate
 * cannot answer, so it is the aged debtors report rewound to the period end.
 */

import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAROutstandingSummary } from '@/modules/accounting/services/ar/arOutstandingService';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

export interface SalesFigures {
  overdue: number;
  total: number;
  customers: number;
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

export async function getSalesFigures(companyId: string, periodEnd: string): Promise<SalesFigures> {
  const today = asAtTodayStr();
  const open = periodEnd >= today;
  const buckets = await getARAging(companyId, open ? today : periodEnd);
  if (!open) return { ...sumAging(buckets), customers: buckets.length };
  const summary = await getAROutstandingSummary(companyId);
  return { overdue: summary.overdueAmount, total: summary.outstanding, customers: buckets.length };
}
