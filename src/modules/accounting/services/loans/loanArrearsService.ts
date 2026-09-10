import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { ScheduleRow } from '@/lib/amortisation/types';

type Row = DbRow;

/**
 * Days past due for IFRS 9 staging.
 *
 * `scheduledDate` is the OLDEST instalment that is still unsettled, so arrears
 * run from that due date forward to the assessment date. The first parameter is
 * retained for the exported signature; measuring the lateness of the last
 * payment received (`paid − scheduled`) answers a different question and
 * reports 0 for a borrower who has simply stopped paying.
 */
export function computeDaysPastDue(
  _lastPaymentDate: string | null,
  asOfDate: string,
  scheduledDate?: string | null,
): number {
  if (!scheduledDate) return 0;
  const scheduled = new Date(scheduledDate).getTime();
  const asOf = new Date(asOfDate).getTime();
  if (asOf <= scheduled) return 0;
  return Math.max(0, Math.round((asOf - scheduled) / (1000 * 60 * 60 * 24)));
}

export interface ArrearsPosition {
  /** Due date of the oldest unsettled instalment, or null when none is due. */
  scheduledDate: string | null;
  /** Latest receipt seen, for reporting only. */
  lastPaymentDate: string | null;
  /** False when the loan has no rows in loan_payments at all. */
  hasReceipts: boolean;
}

/**
 * Resolve which instalment a loan is in arrears on.
 *
 * `loan_payments` is the receipt subledger: one row per instalment actually
 * paid, keyed `(company_id, loan_id, period_number)`. It is the ONLY evidence
 * of settlement here.
 *
 * `loan_gl_postings` is deliberately not consulted. `postPeriodJournals` writes
 * the CONTRACTUAL instalment journal whether or not cash arrived, dated to the
 * schedule, so treating it as a payment record means a company that posts its
 * period journals on time reads as current while the borrower pays nothing —
 * which is exactly the defect K-082 exists to close, and it survives any
 * fallback that consults that table.
 *
 * A loan with no receipts captured therefore measures arrears from its oldest
 * due instalment. That is the honest reading of the data available, and it is
 * the conservative direction for a loss allowance; `hasReceipts` lets the
 * caller record that the basis was an absent subledger rather than a default.
 */
export async function resolveArrears(
  companyId: string,
  loanId: string,
  schedule: ScheduleRow[],
  asOfDate: string,
): Promise<ArrearsPosition> {
  const paid = (await sql`
    SELECT period_number, MAX(payment_date) AS payment_date
    FROM loan_payments
    WHERE company_id = ${companyId} AND loan_id = ${loanId}
    GROUP BY period_number
  `) as Row[];

  const settledPeriods = new Set(
    paid.filter((r) => r.period_number != null).map((r) => Number(r.period_number)),
  );
  const paymentDates = paid
    .filter((r) => r.payment_date != null)
    .map((r) => fmtDate(r.payment_date));
  const lastPaymentDate = paymentDates.length > 0
    ? paymentDates.reduce((a, b) => (a > b ? a : b))
    : null;

  const oldestUnsettled = schedule.find(
    (r) => !r.skip && r.date <= asOfDate && !settledPeriods.has(r.period),
  );

  return {
    scheduledDate: oldestUnsettled ? oldestUnsettled.date : null,
    lastPaymentDate,
    hasReceipts: paid.length > 0,
  };
}

/**
 * Note recorded on an assessment measured with no receipts captured at all.
 * The days past due are right for the data present; the remedy is to record
 * the payments, not to re-run the assessment.
 */
export function arrearsBasisNote(hasReceipts: boolean, daysPastDue: number): string | null {
  return !hasReceipts && daysPastDue > 0
    ? 'No loan_payments receipts recorded for this loan; arrears measured from the schedule.'
    : null;
}
