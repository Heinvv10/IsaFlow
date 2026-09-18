/**
 * The arithmetic behind the aged tools' totals.
 *
 * Split out of reportsAging.ts for the 300-line cap. Pure: every function here
 * takes rows and returns numbers, which is why the totals can be asserted
 * without a database.
 */
import type { AgingBucket, AgingInvoice } from '@/modules/accounting/types/ap.types';

export interface BucketTotals {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120Plus: number;
}

export function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

export function sumBuckets(rows: readonly AgingBucket[]): BucketTotals {
  const t: BucketTotals = { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0 };
  for (const r of rows) {
    t.current += r.current;
    t.days30 += r.days30;
    t.days60 += r.days60;
    t.days90 += r.days90;
    t.days120Plus += r.days120Plus;
  }
  return {
    current: round2(t.current), days30: round2(t.days30), days60: round2(t.days60),
    days90: round2(t.days90), days120Plus: round2(t.days120Plus),
  };
}

/** Invoices whose bucket was derived from the invoice date, not a due date. */
export function derivedAge(invoices: readonly AgingInvoice[]): { count: number; total: number } {
  const derived = invoices.filter((i) => i.dueDateMissing === true);
  return { count: derived.length, total: round2(derived.reduce((s, i) => s + i.balance, 0)) };
}

