/**
 * What the aged report ACTUALLY reports, taken from the aged report.
 *
 * `reconcile_subledger` used to recompute this from its own snapshot —
 * `ageable + creditNotes − disputes` — which is a second opinion about a figure
 * that already has an owner. The two disagreed by R12,730,757.43 on Velocity AR
 * at today's date, and the reconciliation named the gap
 * `unageable_document`: a claim that the aged report drops invoices with no due
 * date. It did once. Since #303 it ages them from `invoice_date`, so the item
 * described behaviour that no longer existed and R12.7m of a real difference
 * was attributed to a mechanism that had been fixed.
 *
 * `getARAging` / `getAPAging` own the point-in-time reconstruction and its four
 * documented limitations (`services/shared/agingRewind.ts`). This function
 * consumes them and sums what they returned. It deliberately does no
 * arithmetic of its own beyond the sum: anything else would be a third opinion.
 *
 * NOTE on what the sum includes. `AgingBucket.total` is net of `disputed` on
 * AR, and `calculateAgingBuckets` drops rows whose balance is <= 0, so an
 * unallocated credit note never reaches a bucket. Both are real differences
 * between the aged report and the subledger, and both are named as reconciling
 * items on the `aged_to_subledger` bridge rather than smoothed over here.
 */

import { log } from '@/lib/logger';
import { getARAging } from '../ar/arAgingService';
import { getAPAging } from '../ap/apAgingService';
import type { SubledgerRole } from '../gl/controlAccountService';
import { round2 } from './reconciliationMath';

/**
 * The aged report's own total as at the date, or null for a role that has no
 * aged report. Null is not zero: a role with no aged report has nothing to
 * compare against, and a zero would read as agreement.
 *
 * @param asAtDate 'YYYY-MM-DD'. Passed through as a string; the aging services
 *   own every date decision made from it.
 */
export async function getAgedReportTotal(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
): Promise<number | null> {
  if (role !== 'ar' && role !== 'ap') return null;
  try {
    const buckets =
      role === 'ar' ? await getARAging(companyId, asAtDate) : await getAPAging(companyId, asAtDate);
    return round2(buckets.reduce((sum, b) => sum + Number(b.total ?? 0), 0));
  } catch (err) {
    log.error('Failed to read the aged report total', { role, error: err }, 'accounting');
    throw err;
  }
}
