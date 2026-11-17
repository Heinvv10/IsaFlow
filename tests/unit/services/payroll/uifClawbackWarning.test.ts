/**
 * UF round 1 (Hein's ruling on #1482): keep this month's netting of a clawback, and warn. UIF is monthly (UIC Act 4 of
 * 2002 s5(1), s6(1)); an earlier month over-declared is refunded through that month: s8(3) to the employer, s7(5) the
 * employee's share. The warning names both and points at the earlier month's UI-19 / EMP201.
 */
import { describe, expect, it } from 'vitest';
import { UIF_CLAWBACK, uifClawbackWarnings } from '@/modules/accounting/services/payroll/uifClawbackWarning';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EarningPart } from '@/modules/accounting/services/payroll/payrollLineAccumulate';
import { buildCaseInput, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

const part = (included: number, uif = true): EarningPart => ({
  name: 'Salary', code: '3601', amount: included, included, isNonCash: false, taxable: true, uif, sdl: true, treatment: 'periodic',
} as EarningPart);

describe('uifClawbackWarnings', () => {
  it('UIF pay below nil: one warning naming s8(3), s7(5), the earlier month and nil UIF', () => {
    const [w, ...rest] = uifClawbackWarnings([part(5_000), part(-8_000)], -3_000);
    expect(rest).toEqual([]);
    expect(w).toMatchObject({ code: UIF_CLAWBACK, severity: 'warning' });
    expect(w!.message).toMatch(/8[\s ]000/);
    expect(w!.message).toContain('below nil');
    expect(w!.message).toContain('UIF is nil');
    expect(w!.message).toContain('s8(3)');
    expect(w!.message).toContain('s7(5)');
    expect(w!.message).toContain('earlier month');
    expect(w!.message).toContain('UI-19 / EMP201');
  });

  it('a clawback that reduces but does not take the UIF pay below nil still warns', () => {
    const [w] = uifClawbackWarnings([part(10_000), part(-2_000)], 8_000);
    expect(w!.code).toBe(UIF_CLAWBACK);
    expect(w!.message).toContain('reduced this month\'s UIF pay');
  });

  it('no clawback: no warning; a negative earning UIF does not apply to: no warning', () => {
    expect(uifClawbackWarnings([part(10_000)], 10_000)).toEqual([]);
    expect(uifClawbackWarnings([part(10_000), part(-2_000, false)], 10_000)).toEqual([]);
  });
});

function line(components: OracleCase['input']['components'], uifExcluded = false) {
  const c: OracleCase = {
    id: 'uf-clawback-warning', source: 'engine', sourceRef: 'n/a', notes: '',
    input: {
      period: { year: 2026, month: 6 }, taxYear: 2027,
      employee: {
        dateOfBirth: '1990-01-01', startDate: '2020-03-01', taxStatus: 'statutory', uifExcluded,
        medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false,
      },
      employerAnnualRemuneration: 2_000_000, components,
    },
    expected: {},
  };
  return calculatePayrollLine(buildCaseInput(c));
}
const earning = (amount: number) => ({ code: '3601', name: '3601', type: 'earning' as const, amount, taxable: true, uif: true, sdl: true });
const codes = (l: ReturnType<typeof line>) => l.validationResults.map((v) => v.code);

describe('calculatePayrollLine carries UIF_CLAWBACK', () => {
  it('on a clawback line (UIF pay below nil, and reduced)', () => {
    expect(codes(line([earning(5_000), earning(-8_000)]))).toContain(UIF_CLAWBACK);
    expect(codes(line([earning(10_000), earning(-2_000)]))).toContain(UIF_CLAWBACK);
  });

  it('not on an ordinary line, nor where no UIF is costed (UIF-excluded)', () => {
    expect(codes(line([earning(10_000)]))).not.toContain(UIF_CLAWBACK);
    expect(codes(line([earning(5_000), earning(-8_000)], true))).not.toContain(UIF_CLAWBACK);
  });
});
