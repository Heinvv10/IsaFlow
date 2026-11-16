import { describe, it, expect } from 'vitest';
import { loanDue, type LoanRow } from '@/modules/accounting/services/cashForecast13/loanPlan';

const TODAY = '2026-11-18';
const END = '2027-02-14';
// Instalments on the 1st, Aug 2026 .. Mar 2027.
const rows: LoanRow[] = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01']
  .map((date, i) => ({ period: i + 1, date, cents: 1_000 }));

describe('cash13 loan instalments still to pay (review L2)', () => {
  it('no recorded payment: past instalments assumed paid, future ones in the horizon forecast', () => {
    const r = loanDue(rows, [], TODAY, END);
    expect(r.noPayments).toBe(true);
    expect(r.due.map((d) => [d.period, d.overdue])).toEqual([[5, false], [6, false], [7, false]]);
  });

  it('a missed instalment after the first recorded payment is overdue; one before it is assumed paid', () => {
    const r = loanDue(rows, [{ periodNumber: 2, date: '2026-09-01', cents: 1_000 }, { periodNumber: 4, date: '2026-11-01', cents: 1_000 }], TODAY, END);
    expect(r.noPayments).toBe(false);
    // Period 1 (before the first payment) assumed paid; period 3 missed → overdue.
    expect(r.due.map((d) => [d.period, d.overdue, d.cents])).toEqual([[3, true, 1_000], [5, false, 1_000], [6, false, 1_000], [7, false, 1_000]]);
  });

  it('a future instalment paid early is not forecast again; a part payment leaves the rest', () => {
    const r = loanDue(rows, [{ periodNumber: 5, date: '2026-11-10', cents: 1_000 }, { periodNumber: 6, date: '2026-11-10', cents: 300 }], TODAY, END);
    expect(r.due.map((d) => [d.period, d.cents])).toEqual([[6, 700], [7, 1_000]]);
  });

  it('a payment with no period number nets by amount against the instalments due in its own month', () => {
    const r = loanDue(rows, [{ periodNumber: null, date: '2026-10-03', cents: 1_000 }, { periodNumber: null, date: '2026-12-02', cents: 400 }], TODAY, END);
    // October settled (no overdue), November (after the first payment, unsettled) overdue, December 600 left.
    expect(r.due.map((d) => [d.period, d.overdue, d.cents])).toEqual([[4, true, 1_000], [5, false, 600], [6, false, 1_000], [7, false, 1_000]]);
  });

  it('a period number the schedule does not have is netted by amount in its month, like a blank one', () => {
    const r = loanDue(rows, [{ periodNumber: 99, date: '2026-12-05', cents: 1_000 }], TODAY, END);
    expect(r.due.map((d) => d.period)).toEqual([6, 7]);
  });

  it('an instalment after the horizon is never returned, even when unpaid', () => {
    expect(loanDue(rows, [], TODAY, END).due.some((d) => d.period === 8)).toBe(false);
  });

  it('with payments, an unmatched instalment within 60 days is overdue; an older one is assumed paid and listed (re-review L-e)', () => {
    // Aug paid; Sep, Oct and Nov missed. today 2026-11-18: Nov 1 (17 days) and Oct 1 (48) overdue, Sep 1 (78) assumed paid.
    const r = loanDue(rows, [{ periodNumber: 1, date: '2026-08-01', cents: 1_000 }], TODAY, END);
    expect(r.due.filter((d) => d.overdue).map((d) => d.period)).toEqual([3, 4]);
    expect(r.assumedPaid.map((d) => d.period)).toEqual([2]);
    // A month later (look-back from 2026-10-19): Sep and Oct are assumed paid; Nov and Dec are overdue.
    const later = loanDue(rows, [{ periodNumber: 1, date: '2026-08-01', cents: 1_000 }], '2026-12-18', '2027-03-14');
    expect(later.due.filter((d) => d.overdue).map((d) => d.period)).toEqual([4, 5]);
    expect(later.assumedPaid.map((d) => [d.period, d.cents])).toEqual([[2, 1_000], [3, 1_000]]);
  });
});
