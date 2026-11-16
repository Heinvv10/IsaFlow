/**
 * Which loan instalments are still to pay (review L2). Pure.
 *
 * A payment (`loan_payments`) settles the schedule row it names by `period_number`. One with no period
 * number cannot be matched to a row reliably, so it is netted BY AMOUNT against the rows due in the same
 * month as the payment, earliest first.
 *   - A loan with NO recorded payment: its past instalments are assumed paid (the company pays it outside
 *     IsaFlow's loan payments; on dev every active loan is like this) and the caller warns
 *     `loan_payments_not_recorded`. Future instalments are forecast in full.
 *   - Otherwise: an instalment due before today, on or after the first recorded payment's date, and not fully
 *     settled is OVERDUE — forecast in week 1, flagged `loan_overdue` — but only when it fell due in the last
 *     `OVERDUE_LOOKBACK_DAYS` (re-review L-e): an older unmatched one is far more often a lapse in recording than
 *     a debt, so it is assumed paid and returned in `assumedPaid` for the caller to list. One before the first
 *     recorded payment is assumed paid. A future instalment already settled (paid early) is not forecast again;
 *     a part-paid one forecasts what is left.
 */
import { addDays } from './weeks';

export const OVERDUE_LOOKBACK_DAYS = 60;

export interface LoanRow { period: number; date: string; cents: number }
export interface LoanPayment { periodNumber: number | null; date: string; cents: number }
export interface LoanDue { period: number; date: string; cents: number; overdue: boolean }

export function loanDue(
  rows: readonly LoanRow[], payments: readonly LoanPayment[], today: string, horizonEnd: string,
): { due: LoanDue[]; assumedPaid: LoanRow[]; noPayments: boolean } {
  const left = new Map(rows.map((r) => [r.period, r.cents]));
  const take = (period: number, cents: number): number => {
    const owing = left.get(period) ?? 0;
    const used = Math.min(owing, cents);
    left.set(period, owing - used);
    return cents - used;
  };
  const sorted = [...rows].sort((a, b) => a.period - b.period);
  for (const p of payments) {
    if (p.periodNumber !== null && left.has(p.periodNumber)) take(p.periodNumber, p.cents);
  }
  for (const p of payments) {
    if (p.periodNumber !== null && left.has(p.periodNumber)) continue;
    let rest = p.cents;
    for (const r of sorted) {
      if (rest <= 0) break;
      if (r.date.slice(0, 7) === p.date.slice(0, 7)) rest = take(r.period, rest);
    }
  }
  const firstPaid = payments.length === 0 ? null : payments.map((p) => p.date).sort()[0] as string;
  const lookback = addDays(today, -OVERDUE_LOOKBACK_DAYS);
  const due: LoanDue[] = [];
  const assumedPaid: LoanRow[] = [];
  for (const r of sorted) {
    const owing = left.get(r.period) ?? 0;
    if (owing <= 0 || r.date > horizonEnd) continue;
    if (r.date >= today) due.push({ period: r.period, date: r.date, cents: owing, overdue: false });
    else if (firstPaid !== null && r.date >= firstPaid) {
      if (r.date >= lookback) due.push({ period: r.period, date: r.date, cents: owing, overdue: true });
      else assumedPaid.push({ period: r.period, date: r.date, cents: owing });
    }
  }
  return { due, assumedPaid, noPayments: payments.length === 0 };
}
