/**
 * previousBusinessDay: the one "move back" rule for statutory due dates and pay dates. A date on a weekend or a
 * South African public holiday moves back to the last business day before it (TAA s244), across month and year ends.
 */
import { describe, expect, it } from 'vitest';
import { previousBusinessDay } from '@/modules/bureau/services/vatPeriodHelper';

describe('previousBusinessDay', () => {
  it('a weekday that is no holiday stays', () => {
    expect(previousBusinessDay(2026, 6, 25)).toBe('2026-06-25');
  });

  it('Saturday and Sunday go back to Friday (the old weekend rule)', () => {
    expect(previousBusinessDay(2026, 4, 25)).toBe('2026-04-24');
    expect(previousBusinessDay(2026, 10, 25)).toBe('2026-10-23');
  });

  it('a weekday holiday goes back one day: Friday 25 Dec 2026 -> Thursday 24 Dec', () => {
    expect(previousBusinessDay(2026, 12, 25)).toBe('2026-12-24');
  });

  it('Wednesday 16 Dec 2026 (Day of Reconciliation) -> Tuesday 15 Dec', () => {
    expect(previousBusinessDay(2026, 12, 16)).toBe('2026-12-15');
  });

  it('a Saturday holiday after a Friday holiday goes back past both: Sat 26 Dec 2026 -> Thu 24 Dec', () => {
    expect(previousBusinessDay(2026, 12, 26)).toBe('2026-12-24');
  });

  it('Easter: Monday 6 Apr 2026 (Family Day) -> Thursday 2 Apr (Good Friday 3 Apr is a holiday too)', () => {
    expect(previousBusinessDay(2026, 4, 6)).toBe('2026-04-02');
  });

  it('Sunday-rule Monday: 2 May 2022 (Mon, the 1 May Sunday holiday) -> Friday 29 Apr', () => {
    expect(previousBusinessDay(2022, 5, 2)).toBe('2022-04-29');
  });

  it('crosses a year end: Friday 1 Jan 2027 -> Thursday 31 Dec 2026', () => {
    expect(previousBusinessDay(2027, 1, 1)).toBe('2026-12-31');
  });

  it('crosses a month end: Monday 1 May 2028 (Labour Day) -> Friday 28 Apr 2028', () => {
    expect(previousBusinessDay(2028, 5, 1)).toBe('2028-04-28');
  });
});
