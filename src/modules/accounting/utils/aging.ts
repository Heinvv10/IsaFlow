/**
 * PRD-060: FibreFlow Accounting Module
 * AP/AR Aging Bucket Calculations
 *
 * Calculates aging buckets: Current, 30, 60, 90, 120+ days
 * Used for both Accounts Payable and Accounts Receivable.
 */

import type { AgingBucket, AgingBucketName, AgingInvoice } from '../types/ap.types';

/**
 * Classify a single invoice into an aging bucket based on due date.
 *
 * - Current: not yet due (due date >= as-at date)
 * - 30 days: 1-30 days overdue
 * - 60 days: 31-60 days overdue
 * - 90 days: 61-90 days overdue
 * - 120+ days: 91+ days overdue
 */
export function getAgingBucket(dueDate: Date, asAtDate: Date): AgingBucketName {
  const diffMs = asAtDate.getTime() - dueDate.getTime();
  const daysOverdue = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'days30';
  if (daysOverdue <= 60) return 'days60';
  if (daysOverdue <= 90) return 'days90';
  return 'days120Plus';
}

/**
 * Calculate aging buckets for a set of invoices, grouped by entity (supplier or client).
 *
 * - Excludes zero-balance invoices
 * - Groups by entityId
 * - Sorts by total descending
 */
export function calculateAgingBuckets(
  invoices: AgingInvoice[],
  asAtDate: Date
): AgingBucket[] {
  // Filter out zero-balance invoices
  const outstanding = invoices.filter(inv => inv.balance > 0);

  if (outstanding.length === 0) return [];

  // Group by entity
  const grouped = new Map<string, AgingBucket>();

  for (const inv of outstanding) {
    const bucket = getAgingBucket(new Date(inv.dueDate), asAtDate);

    if (!grouped.has(inv.entityId)) {
      grouped.set(inv.entityId, {
        entityId: inv.entityId,
        entityName: inv.entityName,
        current: 0,
        days30: 0,
        days60: 0,
        days90: 0,
        days120Plus: 0,
        total: 0,
      });
    }

    const entry = grouped.get(inv.entityId)!;
    entry[bucket] += inv.balance;
    entry.total += inv.balance;
  }

  // Sort by total descending
  return Array.from(grouped.values()).sort((a, b) => b.total - a.total);
}
