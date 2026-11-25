/**
 * FQe (wave 7, engine 23): loadPayeYearToDate returns the periods by each line's run frequency, and a restored pre-948
 * line (payrollYearToDateLegacy) counts one period of ITS run's frequency, in both the periods and the cap periods
 * (review #1928: the frequencies of restored lines). The calculator then converts them (payrollYearToDateFrequency).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, unsafeMock } = vi.hoisted(() => {
  const unsafeMock = vi.fn((text: string) => text);
  return { sqlMock: Object.assign(vi.fn(), { unsafe: unsafeMock }), unsafeMock };
});
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/payroll/payrollMedicalRecord', () => ({ loadMedicalRecord: vi.fn(async () => new Map()) }));

import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { withRestored } from '@/modules/accounting/services/payroll/payrollYearToDateLegacy';

const EMP = '00000000-0000-0000-0000-0000000000e1';
const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const RUN = '00000000-0000-0000-0000-0000000000a1';

beforeEach(() => { sqlMock.mockReset(); unsafeMock.mockClear(); });

describe('withRestored', () => {
  it('keeps the non-zero buckets and adds one per restored line in its own frequency', () => {
    expect(withRestored({ weekly: 4, fortnightly: 0, monthly: 0 }, ['m1', 'w1'], { m1: 'monthly', w1: 'weekly' }))
      .toEqual({ weekly: 5, monthly: 1 });
    expect(withRestored(null, [], {})).toEqual({});
  });
});

describe('loadPayeYearToDate by frequency (FQe)', () => {
  it('reads the share sums by run frequency, the cap periods likewise, and each unpaid line\'s frequency', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 6 }, [EMP]);
    const query = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
    for (const f of ['weekly', 'fortnightly', 'monthly']) {
      expect(query).toContain(`'${f}', COALESCE(SUM(share) FILTER (WHERE on_tables AND periodic_before_deductions > 0 AND pay_frequency = '${f}'), 0)`);
      expect(query).toContain(`FILTER (WHERE on_tables AND cap_period AND pay_frequency = '${f}'), 0)`);
    }
    expect(query).toContain('AS periods_by_frequency');
    expect(query).toContain('AS cap_periods_by_frequency');
    expect(query).toContain("(r.periodic_before_deductions > 0 OR (r.annual_before_deductions > 0 AND h.run_kind = 'regular')) AS cap_period");
    expect(query).toContain('jsonb_object_agg(line_id::text, pay_frequency) FILTER (WHERE on_tables AND periodic_before_deductions <= 0) AS unpaid_line_frequencies');
  });

  it('a restored monthly legacy line in a weekly year lands in the monthly bucket, for periods and cap periods', async () => {
    sqlMock
      .mockResolvedValueOnce([{
        employee_id: EMP, periods: 8, retirement_cap_periods: 8, frequencies: ['monthly', 'weekly'],
        periods_by_frequency: { weekly: 8, fortnightly: 0, monthly: 0 },
        cap_periods_by_frequency: { weekly: 8, fortnightly: 0, monthly: 0 },
        unpaid_lines: { 'line-march': 0 }, uncounted_cap_lines: { 'line-march': true },
        unpaid_line_frequencies: { 'line-march': 'monthly' },
        taxable_splits: { 'line-march': { periodic: 0, annual: 0, annualGross: 0, originalTaxable: 20_000 } },
        periodic: '40000', annual: '0', table_paye: '4000', medical_credit: '0', additional_medical_credit: '0',
      }])
      .mockResolvedValueOnce([{
        employee_id: EMP, pension: '0', provident: '0', annuity: '20000', contributions: '20000', deduction: '20000',
        legacy_taxable: '20000', legacy_by_line: { 'line-march': 20_000 }, donations: '0',
      }]);
    const ytd = (await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 6 }, [EMP])).get(EMP)!;
    expect(ytd.periods).toBe(9);
    expect(ytd.retirementCapPeriods).toBe(9);
    expect(ytd.periodsByFrequency).toEqual({ weekly: 8, monthly: 1 });
    expect(ytd.retirementCapPeriodsByFrequency).toEqual({ weekly: 8, monthly: 1 });
  });
});
