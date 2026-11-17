/** Wave 6 SS: a leaver's portal access ends with the NEXT tax year (ruling §0a.14; SA tax year ends end of February). */
import { describe, expect, it } from 'vitest';
import { leaverAccessEnds, portalAccessEnds, portalAccessOpen, todaySast } from '@/modules/accounting/services/payroll/employeePortalWindow';

describe('employee portal access window', () => {
  it('ends on the last day of February after the tax year the employee left in', () => {
    expect(leaverAccessEnds('2026-02-28')).toBe('2027-02-28'); // tax year 2026 -> next ends Feb 2027
    expect(leaverAccessEnds('2026-03-01')).toBe('2028-02-29'); // tax year 2027 -> next ends Feb 2028 (leap)
    expect(leaverAccessEnds('2027-12-31')).toBe('2029-02-28');
    expect(leaverAccessEnds('2099-01-31')).toBe('2100-02-28'); // 2100 is not a leap year
  });
  it('is open through that day and closed the day after', () => {
    const leaver = { status: 'terminated', endDate: '2026-03-01' };
    expect(portalAccessOpen(leaver, '2028-02-29')).toBe(true);
    expect(portalAccessOpen(leaver, '2028-03-01')).toBe(false);
  });
  it('has no limit for an active employee and fails closed for any other status with no end date', () => {
    expect(portalAccessEnds({ status: 'active', endDate: null })).toBeNull();
    expect(portalAccessOpen({ status: 'active', endDate: null }, '2099-01-01')).toBe(true);
    expect(portalAccessOpen({ status: 'inactive', endDate: null }, '2026-01-01')).toBe(false);
    expect(portalAccessOpen({ status: 'terminated', endDate: null }, '2026-01-01')).toBe(false);
  });
  it('reads today in South Africa, not UTC', () => {
    expect(todaySast(new Date('2026-02-28T22:30:00Z'))).toBe('2026-03-01');
  });
});
