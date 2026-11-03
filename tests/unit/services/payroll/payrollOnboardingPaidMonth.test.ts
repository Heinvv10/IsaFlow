/**
 * The refusal text for a hire whose open-ended salary would run through months the company's paid runs already paid:
 * every month from the salary's start through the latest paid month is named (paid ones, and open ones that cannot
 * start the salary because a later month is paid), and the salary is moved to the month after the latest.
 */
import { describe, expect, it } from 'vitest';
import { salaryPaidMonthText } from '@/modules/accounting/services/payroll/payrollOnboardingPaidMonth';

const paid = (...ym: Array<[number, number]>) => ym.map(([year, month]) => ({ year, month }));

describe('salaryPaidMonthText', () => {
  it.each([
    ['one paid month', paid([2026, 2]), '2026-02-10',
      'February 2026 is already paid. Set the salary to start 2026-03-01 and pay the February days as a once-off in an open month.'],
    ['several paid months in a row', paid([2026, 1], [2026, 2], [2026, 3]), '2026-01-05',
      'January, February and March 2026 are already paid. Set the salary to start 2026-04-01 and pay those days as once-offs in an open month.'],
    ['two paid months across a year end', paid([2025, 12], [2026, 1]), '2025-12-10',
      'December 2025 and January 2026 are already paid. Set the salary to start 2026-02-01 and pay those days as once-offs in an open month.'],
    ['an open month between two paid ones', paid([2026, 2], [2026, 4]), '2026-02-01',
      'February and April 2026 are already paid, so March 2026 cannot start the salary either. '
      + 'Set the salary to start 2026-05-01 and pay the February, March and April days as once-offs in an open month.'],
    ['a start in the open month before a later paid one', paid([2026, 2], [2026, 4]), '2026-03-10',
      'April 2026 is already paid, so March 2026 cannot start the salary either. '
      + 'Set the salary to start 2026-05-01 and pay the March and April days as once-offs in an open month.'],
    ['paid months before the start are not named', paid([2026, 1], [2026, 3]), '2026-03-01',
      'March 2026 is already paid. Set the salary to start 2026-04-01 and pay the March days as a once-off in an open month.'],
    ['December paid: the next month is January', paid([2026, 12]), '2026-12-01',
      'December 2026 is already paid. Set the salary to start 2027-01-01 and pay the December days as a once-off in an open month.'],
    ['a list that crosses a year end names each year', paid([2026, 11], [2027, 1]), '2026-11-05',
      'November 2026 and January 2027 are already paid, so December 2026 cannot start the salary either. '
      + 'Set the salary to start 2027-02-01 and pay the November 2026, December 2026 and January 2027 days as once-offs in an open month.'],
  ])('%s', (_name, periods, from, text) => {
    expect(salaryPaidMonthText(periods, from)).toBe(text);
  });

  it('a gap of more than twelve months names each month with its year', () => {
    const text = salaryPaidMonthText(paid([2026, 2], [2027, 4]), '2026-02-01')!;
    expect(text).toContain('pay the February 2026, March 2026, April 2026');
    expect(text).toContain('and April 2027 days as once-offs');
    expect(text).toContain('start 2027-05-01');
  });

  it('is null when no paid month falls on or after the start', () => {
    expect(salaryPaidMonthText(paid([2026, 1]), '2026-02-01')).toBeNull();
    expect(salaryPaidMonthText([], '2026-02-01')).toBeNull();
  });

  describe('with an end date', () => {
    it('paid months after the end do not count', () => {
      expect(salaryPaidMonthText(paid([2026, 1], [2026, 2]), '2025-12-01', '2025-12-31')).toBeNull();
      expect(salaryPaidMonthText(paid([2026, 2]), '2026-01-05', '2026-01-31')).toBeNull();
    });

    it('a paid month inside the window is named, and the advice starts in the open month after it when the end leaves room', () => {
      expect(salaryPaidMonthText(paid([2026, 2]), '2026-02-10', '2026-04-30')).toBe(
        'February 2026 is already paid. Set the salary to start 2026-03-01 and pay the February days as a once-off in an open month.');
    });

    it('when the end date leaves no open month, the advice is to pay it as once-offs and create the employee without a salary', () => {
      expect(salaryPaidMonthText(paid([2026, 1], [2026, 2]), '2025-12-01', '2026-01-31')).toBe(
        'January 2026 is already paid, so December 2025 cannot start the salary either. The end date 2026-01-31 leaves no open month for the salary: '
        + 'pay the December 2025 and January 2026 days as once-offs in an open month and create the employee without a salary.');
      expect(salaryPaidMonthText(paid([2026, 2]), '2026-02-10', '2026-02-28')).toBe(
        'February 2026 is already paid. The end date 2026-02-28 leaves no open month for the salary: '
        + 'pay the February days as a once-off in an open month and create the employee without a salary.');
    });
  });
});
