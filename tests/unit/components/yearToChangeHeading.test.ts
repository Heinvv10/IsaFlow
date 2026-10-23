/** The wizard and Settings name the year a change applies to: "current" only when it holds today. */
import { describe, expect, it } from 'vitest';
import { yearToChangeHeading } from '@/components/accounting/financialYearEnd/yearEndTypes';

const fy = { startDate: '2026-01-01', endDate: '2027-02-28' };

describe('yearToChangeHeading', () => {
  it('is the current year on its first day, a day inside it and its last day', () => {
    for (const today of ['2026-01-01', '2026-10-23', '2027-02-28']) expect(yearToChangeHeading(fy, today)).toBe('Current financial year');
  });
  it('is the next open year when today is before it (the year holding today is closed)', () => {
    expect(yearToChangeHeading({ startDate: '2027-03-01', endDate: '2028-02-29' }, '2026-10-23')).toBe('Next open financial year');
  });
});
