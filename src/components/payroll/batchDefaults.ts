/** Defaults for payroll batch lines (pages/payroll/batches/[id]). */
import { payrollRunReadDate } from '@/modules/accounting/services/payroll/payrollRunReadDate';

/**
 * The effective date a batch line gets when the capturer leaves it blank, 'YYYY-MM-DD'. A once-off line: the batch
 * month's last day, paid in that month's run. A RECURRING line: the 1st of the next month. A recurring row starting
 * after the 27th is flagged for a manual pro-rata and refuses the run (payrollRecurringProRata), so month end would
 * flag every line of a recurring batch.
 */
export function defaultBatchEffectiveFrom(batch: { periodYear: number; periodMonth: number; isRecurring: boolean }): string {
  if (!batch.isRecurring) return payrollRunReadDate({ year: batch.periodYear, month: batch.periodMonth });
  const year = batch.periodMonth === 12 ? batch.periodYear + 1 : batch.periodYear;
  const month = batch.periodMonth === 12 ? 1 : batch.periodMonth + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}
