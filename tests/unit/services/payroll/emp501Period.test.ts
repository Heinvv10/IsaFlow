/** EMP501 periods (wave 6 EFb): interim = March to August of the year before the tax year ends, MM 08; annual = the tax year, MM 02. */
import { describe, expect, it } from 'vitest';
import { emp501Period, emp501PeriodOf, reconciliationPeriodCode } from '@/modules/accounting/services/payroll/emp501Period';

describe('emp501Period', () => {
  it('interim of tax year 2027 is 2026-03-01..2026-08-31, code 202708', () => {
    const p = emp501Period(2027, 'interim');
    expect(p).toMatchObject({ start: '2026-03-01', end: '2026-08-31', mm: 8, startYear: 2026, startMonth: 3, endYear: 2026, endMonth: 8 });
    expect(reconciliationPeriodCode(p)).toBe(202708);
  });

  it('annual of tax year 2028 ends on the leap day, code 202802', () => {
    const p = emp501Period(2028, 'annual');
    expect(p).toMatchObject({ start: '2027-03-01', end: '2028-02-29', mm: 2, endYear: 2028, endMonth: 2 });
    expect(reconciliationPeriodCode(p)).toBe(202802);
  });

  it('emp501PeriodOf recognises exactly the two windows', () => {
    expect(emp501PeriodOf('2026-03-01', '2026-08-31')).toMatchObject({ taxYear: 2027, kind: 'interim' });
    expect(emp501PeriodOf('2026-03-01', '2027-02-28')).toMatchObject({ taxYear: 2027, kind: 'annual' });
    expect(emp501PeriodOf('2026-03-01', '2027-02-27')).toBeNull();
    expect(emp501PeriodOf('2026-03-02', '2026-08-31')).toBeNull();
    expect(emp501PeriodOf('2026-03-01', '2026-09-30')).toBeNull();
  });
});
