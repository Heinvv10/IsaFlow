/**
 * The refusal text for a hire whose open-ended salary would run through months the company's paid runs already paid:
 * every month from the salary's start through the latest paid month is named (paid ones, and open ones that cannot
 * start the salary because a later month is paid), and the salary is moved to the month after the latest.
 */
import { describe, expect, it } from 'vitest';
import { salaryEndRefusal, salaryPaidMonthText } from '@/modules/accounting/services/payroll/payrollOnboardingPaidMonth';

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

  it('never advises starting in a month whose end date is before the 27th: that month pays nothing', () => {
    expect(salaryPaidMonthText(paid([2026, 2]), '2026-02-10', '2026-03-15')).toBe(
      'February 2026 is already paid. The end date 2026-03-15 leaves no open month for the salary: '
      + 'pay the February days as a once-off in an open month and create the employee without a salary.');
    expect(salaryPaidMonthText(paid([2026, 2]), '2026-02-10', '2026-03-27')).toBe(
      'February 2026 is already paid. Set the salary to start 2026-03-01 and pay the February days as a once-off in an open month.');
  });
});

describe('salaryEndRefusal: a salary ending before the 27th pays nothing that month', () => {
  it('is refused with the previous month end as the advice when the salary started before it', () => {
    expect(salaryEndRefusal('2026-03-05', '2026-04-15')).toBe(
      'A salary ending on 2026-04-15 is paid nothing for April 2026 (a run reads pay components on the last day of the month, so a salary that '
      + 'ends before the 27th is not paid that month). End the salary on 2026-03-31 and pay the April days as a once-off in an open month.');
  });

  it('with no month before it to end in, the advice is no salary and a once-off', () => {
    expect(salaryEndRefusal('2026-03-01', '2026-03-15')).toBe(
      'A salary ending on 2026-03-15 is paid nothing for March 2026 (a run reads pay components on the last day of the month, so a salary that '
      + 'ends before the 27th is not paid that month). Create the employee without a salary and pay the March days as a once-off in an open month.');
  });

  it('January looks back to December', () => {
    expect(salaryEndRefusal('2025-11-01', '2026-01-10')).toContain('End the salary on 2025-12-31 and pay the January days');
  });

  it.each([['2026-03-27'], ['2026-03-31'], [null]])('%s is fine', (to) => {
    expect(salaryEndRefusal('2026-03-01', to)).toBeNull();
  });

  it('the 26th is refused', () => {
    expect(salaryEndRefusal('2026-03-01', '2026-03-26')).not.toBeNull();
  });
});

describe('salaryEndRefusal: a salary that ends before the employment does must end on a month\'s last day', () => {
  const notWithEmployment = (from: string, to: string) => salaryEndRefusal(from, to, false);

  it('refuses the 27th to the 30th, which a run does not read, and advises the previous month end or its own', () => {
    expect(notWithEmployment('2026-03-05', '2026-04-28')).toBe(
      'A salary that ends before the employment does must end on the last day of a month: a run reads pay components on that day, so a salary ending on '
      + '2026-04-28 is not paid for April 2026 and blocks its run. End the salary on 2026-03-31 and pay the April days as a once-off in an open month, '
      + 'or on 2026-04-30 to pay all of April.');
  });

  it('with no month before it to end in, only its own month end is offered', () => {
    expect(notWithEmployment('2026-03-05', '2026-03-28')).toContain('End the salary on 2026-03-31 to pay all of March.');
  });

  it('a month end is fine, the 27th is not (it is only read when it ends with the employment)', () => {
    expect(notWithEmployment('2026-03-05', '2026-04-30')).toBeNull();
    expect(notWithEmployment('2026-03-01', '2026-03-27')).not.toBeNull();
    expect(salaryEndRefusal('2026-03-01', '2026-03-27', true)).toBeNull();
  });

  it('the paid-month advice does not offer a month whose end date is not a month end either', () => {
    expect(salaryPaidMonthText(paid([2026, 2]), '2026-02-10', '2026-03-28', false)).toContain('leaves no open month');
    expect(salaryPaidMonthText(paid([2026, 2]), '2026-02-10', '2026-03-28', true)).toContain('Set the salary to start 2026-03-01');
  });
});

describe('salaryEndRefusal knows the employment end date (advice must be acceptable when followed)', () => {
  const early = (from: string, to: string, endDay: string) => salaryEndRefusal(from, to, false, endDay);

  it('the employment ends on the 20th of the salary end month: only the previous month end is offered', () => {
    const text = early('2026-03-01', '2026-04-10', '2026-04-20')!;
    expect(text).toContain('End the salary on 2026-03-31 and pay the April days as a once-off in an open month.');
    expect(text).not.toContain('2026-04-30');
  });

  it('and with no month before it to end in: no salary, once-off', () => {
    expect(early('2026-04-01', '2026-04-10', '2026-04-20')).toContain('Create the employee without a salary and pay the April days as a once-off in an open month.');
  });

  it('the employment ends on the 28th: end the salary with it, or omit salary.effectiveTo', () => {
    expect(early('2026-03-01', '2026-04-10', '2026-04-28')).toContain('End the salary with the employment on 2026-04-28 (or omit salary.effectiveTo).');
  });

  // Every value an advice string names, fed back through the same check, is accepted.
  it.each([
    ['2026-03-05', '2026-04-28', '2026-05-15'],
    ['2026-03-05', '2026-03-28', '2026-04-15'],
    ['2026-03-01', '2026-04-10', '2026-04-20'],
    ['2026-03-01', '2026-04-10', '2026-04-28'],
    ['2026-03-01', '2026-04-10', '2026-04-27'],
    ['2026-03-05', '2026-04-28', '2026-04-29'],
    ['2026-03-05', '2026-04-20', '2026-04-20'],
    ['2026-03-05', '2026-04-15', '2026-04-15'],
  ])('from %s to %s, employment ends %s: each advised end date passes', (from, to, endDay) => {
    const text = salaryEndRefusal(from, to, to === endDay, endDay)!;
    expect(text).not.toBeNull();
    const advised = [...text.matchAll(/(?:End the salary on|or on|with the employment on) (\d{4}-\d\d-\d\d)/g)].map((m) => m[1]!);
    for (const day of advised) {
      expect(day >= from, `${day} is not before the start`).toBe(true);
      expect(day <= endDay, `${day} is not after the employment ends`).toBe(true);
      expect(salaryEndRefusal(from, day, day === endDay, endDay), `${day} is accepted`).toBeNull();
    }
    if (advised.length === 0) expect(text).toContain('Create the employee without a salary');
  });
});

