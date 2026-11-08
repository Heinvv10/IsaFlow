/**
 * The SDL year to date the loader hands the calculator (payrollYearToDate, payrollSdlYearToDate). The SQL is
 * exercised on real Postgres by tests/integration/p4c-sdl-year-to-date.int.test.ts; here the query's shape and
 * the row handling, with sql mocked (as payrollYearToDateLegacyPeriods.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, unsafeMock } = vi.hoisted(() => {
  const unsafeMock = vi.fn((text: string) => text);
  return { sqlMock: Object.assign(vi.fn(), { unsafe: unsafeMock }), unsafeMock };
});
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/payroll/payrollMedicalRecord', () => ({ loadMedicalRecord: vi.fn(async () => new Map()) }));

import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';

const EMP = '00000000-0000-0000-0000-0000000000e1';
const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const RUN = '00000000-0000-0000-0000-0000000000a1';

beforeEach(() => { sqlMock.mockReset(); unsafeMock.mockClear(); });

const row = (sdlLines: unknown) => ({
  employee_id: EMP, periods: 2, retirement_cap_periods: 2, unpaid_lines: null, uncounted_cap_lines: null, taxable_splits: {},
  periodic: '40000', annual: '0', table_paye: '0', medical_credit: '0', additional_medical_credit: '0', sdl_lines: sdlLines,
});
const record = (legacy: Record<string, number>) => ({
  employee_id: EMP, pension: '0', provident: '0', annuity: '0', contributions: '0', deduction: '0',
  legacy_taxable: '0', legacy_by_line: legacy, donations: '0',
});

describe('loadPayeYearToDate: SDL year to date (SDL Act s3(3); SDL-GEN-01-G01 Rev 5 s6)', () => {
  it('reads SDL-applicable pay from the isSdlApplicable flag as costed, else from today\'s catalogue, over the same lines in period order', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 5 }, [EMP]);
    const query = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(query).toContain("COALESCE((item->>'isSdlApplicable')::boolean");
    expect(query).toContain('l.sdl_applicable AS stored_sdl_applicable, l.sdl_leviable, l.sdl_exempt');
    expect(query).toContain("pc.component_type = 'earning' AND pc.is_sdl_applicable");
    expect(query).toContain('ORDER BY period_year, period_month, line_created_at, line_id) AS sdl_lines');
    // The SDL columns ride the one line set PAYE reads: no second WHERE.
    expect(query.match(/h\.status = ANY/g)).toHaveLength(1);
  });

  it('sums the stored figures of the liable lines (R20 000 + R20 000, R5 500 + R2 500 deducted)', async () => {
    const stored = (line: string, pay: number, leviable: number, ded: number, exempt: boolean) =>
      ({ line, sdl: exempt ? 0 : leviable / 100, sdlApplicable: pay, rebuiltApplicable: pay, sdlLeviable: leviable, sdlExempt: exempt, retirement: ded });
    sqlMock.mockResolvedValueOnce([row([
      stored('a', 20_000, 14_500, 5_500, false),
      stored('x', 20_000, 14_500, 1_000, true),
      stored('b', 20_000, 17_500, 2_500, false),
    ])]).mockResolvedValueOnce([record({})]);
    const ytd = (await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 6 }, [EMP])).get(EMP)!;
    expect(ytd.sdlApplicable).toBe(40_000);
    expect(ytd.sdlLeviable).toBe(32_000);
    expect(ytd.sdlRetirementDeduction).toBe(8_000);
  });

  it('a line from before migration 957 contributes its pay and no deduction (no credit for earlier months)', async () => {
    sqlMock.mockResolvedValueOnce([row([
      { line: 'legacy', sdl: 300, sdlApplicable: null, rebuiltApplicable: 30_000, sdlLeviable: null, sdlExempt: null, retirement: 3_000 },
    ])]).mockResolvedValueOnce([record({ legacy: 1_000 })]);
    const ytd = (await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 5 }, [EMP])).get(EMP)!;
    expect(ytd.sdlApplicable).toBe(30_000);
    expect(ytd.sdlLeviable).toBe(30_000);
    expect(ytd.sdlRetirementDeduction).toBe(0);
  });

  it('a row without lines (nothing to date) is none', async () => {
    sqlMock.mockResolvedValueOnce([row(null)]).mockResolvedValueOnce([]);
    const ytd = (await loadPayeYearToDate(COMPANY, RUN, { year: 2026, month: 5 }, [EMP])).get(EMP)!;
    expect(ytd.sdlApplicable).toBe(0);
    expect(ytd.sdlLeviable).toBe(0);
    expect(ytd.sdlRetirementDeduction).toBe(0);
  });
});
