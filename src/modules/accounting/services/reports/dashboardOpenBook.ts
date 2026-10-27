/**
 * The open AR or AP book as Home shows it: the AR/AP aging report's own
 * population (ar/arAgingInvoices, ap/apAgingInvoices) bucketed by its own rule
 * (utils/aging), as at one SAST day. The ageing donut and the Receivables /
 * Payables tiles both read it, so the donut (five age buckets plus Disputed),
 * the tile and the report's total are one figure by construction.
 *
 * Disputed amounts leave the age buckets here, as calculateAgingBuckets does,
 * and come back as their own "Disputed" segment. The report keeps them in their
 * age bucket, so each age bucket here plus its disputed share is the report's.
 */
import { calculateAgingBuckets, getAgingBucket, type OpenAgingInvoice } from '../../utils/aging';
import { fetchARAgingInvoices } from '../ar/arAgingInvoices';
import { fetchAPAgingInvoices } from '../ap/apAgingInvoices';

/** The aging report's bucket labels (pages/accounting/reports/ar-aging.tsx), then Disputed. */
export const AGING_BREAKDOWN_LABELS = ['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', 'Disputed'] as const;

export interface OpenBook {
  /** Six values in AGING_BREAKDOWN_LABELS order: the age buckets net of disputes, then Disputed. */
  buckets: number[];
  /** Every open balance, disputed or not: the report's total. */
  total: number;
  /** Open balances already past due on `todayStr`, disputed or not. */
  overdue: number;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** `todayStr` is the SAST app date (YYYY-MM-DD), never the UTC session's CURRENT_DATE. */
export async function getOpenBook(companyId: string, side: 'ar' | 'ap', todayStr: string): Promise<OpenBook> {
  const invoices: OpenAgingInvoice[] = side === 'ar'
    ? await fetchARAgingInvoices(companyId, todayStr, todayStr)
    : await fetchAPAgingInvoices(companyId, todayStr, todayStr);
  const asAt = new Date(todayStr);
  const rows = calculateAgingBuckets(invoices, asAt);
  const keys = ['current', 'days30', 'days60', 'days90', 'days120Plus', 'disputed'] as const;
  const buckets = keys.map((k) => cents(rows.reduce((s, r) => s + (r[k] ?? 0), 0)));
  const open = invoices.filter((inv) => inv.balance > 0);
  return {
    buckets,
    total: cents(open.reduce((s, inv) => s + inv.balance, 0)),
    overdue: cents(open
      .filter((inv) => getAgingBucket(new Date(inv.dueDate), asAt) !== 'current')
      .reduce((s, inv) => s + inv.balance, 0)),
  };
}
