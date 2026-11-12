/**
 * The open AR or AP book as Home shows it: the AR/AP aging report's own
 * population (ar/arAgingInvoices, ap/apAgingInvoices) bucketed by its own rule
 * (utils/aging), as at one SAST day. The ageing donut and the Receivables /
 * Payables tiles both read it, so the donut (five age buckets plus Disputed),
 * the tile and the report's total are one figure by construction.
 *
 * The rule, here and on the aging report alike: the age buckets are net of disputes, Disputed is a column (here a segment)
 * beside them, and the total is the buckets plus Disputed, everything owed. A dispute leaves its age bucket as
 * calculateAgingBuckets does and comes back as its own "Disputed" figure, so this donut's segments add up to the Aged
 * Debtors screen's Total.
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
  /** Open balances already past due on `todayStr`, disputed or not: the report's overdue. */
  overdue: number;
  /**
   * The disputed part of `overdue`. The donut's four overdue slices exclude it,
   * so slices + overdueDisputed = overdue, and the tile can say so.
   */
  overdueDisputed: number;
  /** Customers (AR) or suppliers (AP) with an open balance: the report's row count. */
  parties: number;
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
  const pastDue = open.filter((inv) => getAgingBucket(new Date(inv.dueDate), asAt) !== 'current');
  return {
    buckets,
    total: cents(open.reduce((s, inv) => s + inv.balance, 0)),
    overdue: cents(pastDue.reduce((s, inv) => s + inv.balance, 0)),
    // The same cap calculateAgingBuckets applies: a dispute never exceeds its balance.
    overdueDisputed: cents(pastDue.reduce((s, inv) => s + Math.min(Math.max(inv.disputedAmount ?? 0, 0), inv.balance), 0)),
    parties: rows.length,
  };
}
