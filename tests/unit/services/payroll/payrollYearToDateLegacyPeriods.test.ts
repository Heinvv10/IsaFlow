/**
 * PAYE 4c, review #891: a pre-948 line's taxable-flagged retirement
 * contributions were taken off its periodic_taxable by the old calculator, so
 * a contribution as large as the month's pay stored it as nil. Added back to
 * periodicTaxable, that month must count as a period again (else the year to
 * date annualises its pay over one month too few); a severance-only line, nil
 * with nothing to add back, stays no period.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/payroll/payrollMedicalRecord', () => ({ loadMedicalRecord: vi.fn(async () => new Map()) }));

import { loadPayeYearToDate, yearToDatePeriods } from '@/modules/accounting/services/payroll/payrollYearToDate';

const EMP = '00000000-0000-0000-0000-0000000000e1';
const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const RUN = '00000000-0000-0000-0000-0000000000a1';

beforeEach(() => sqlMock.mockReset());

describe('yearToDatePeriods', () => {
  it('counts a line whose stored periodic pay its legacy deduction took to nil', () => {
    expect(yearToDatePeriods(1, { march: 0 }, { march: 20_000 })).toBe(2);
  });
  it('leaves a nil line with nothing to add back (severance only) as no period', () => {
    expect(yearToDatePeriods(1, { march: 0, april: 0 }, { march: 20_000 })).toBe(2);
    expect(yearToDatePeriods(2, { april: 0 }, {})).toBe(2);
  });
});

describe('loadPayeYearToDate with a pre-948 line reduced to nil', () => {
  it('restores the period through the retirement record (one rule)', async () => {
    // 1: the year-to-date lines (March nil after a R20 000 taxable RA, April R20 000); 2: the retirement record.
    sqlMock
      .mockResolvedValueOnce([{
        employee_id: EMP, periods: 1, unpaid_lines: { 'line-march': '0.00' },
        periodic: '20000', annual: '0', table_paye: '2000', medical_credit: '0', additional_medical_credit: '0',
      }])
      .mockResolvedValueOnce([{
        employee_id: EMP, pension: '0', provident: '0', annuity: '40000', contributions: '40000', deduction: '40000',
        legacy_taxable: '20000', legacy_by_line: { 'line-march': 20000 }, donations: '0',
      }]);
    const ytd = (await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 5 }, [EMP])).get(EMP)!;
    expect(ytd.periods).toBe(2);
    expect(ytd.periodicTaxable).toBe(40_000);
  });

  it('still counts no period for a nil line the record has nothing for', async () => {
    sqlMock
      .mockResolvedValueOnce([{
        employee_id: EMP, periods: 1, unpaid_lines: { 'line-severance': 0 },
        periodic: '20000', annual: '0', table_paye: '2000', medical_credit: '0', additional_medical_credit: '0',
      }])
      .mockResolvedValueOnce([]);
    const ytd = (await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 5 }, [EMP])).get(EMP)!;
    expect(ytd.periods).toBe(1);
    expect(ytd.periodicTaxable).toBe(20_000);
  });
});
