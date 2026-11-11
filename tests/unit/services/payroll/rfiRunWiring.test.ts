/**
 * Wave 5 RF in the run's assembly: the percent rows are costed once, in prepareRunComponents (withRfiCosted), so the loan
 * preview and the stored line read the same components; and the termination base (leave and notice pay) leaves an employer's
 * fund contribution out (it is paid to the fund, not to the employee: BCEA s35(5), not fetched).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const atExit = vi.fn();
vi.mock('@/modules/accounting/services/payroll/payrollComponentService', () => ({ getEmployeeComponents: (...a: unknown[]) => atExit(...a) }));

import { withRfiCosted } from '@/modules/accounting/services/payroll/payrollRunComponents';
import { terminationMonthlySalary } from '@/modules/accounting/services/payroll/payrollRunTermination';
import type { EmployeeComponent, PayrollComponent, ValidationResult } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: `Code ${code}`, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...over,
});

describe('withRfiCosted', () => {
  it('costs the percent rows on RFI and hands the RFI_NIL warning to the line', () => {
    const warnings: ValidationResult[] = [];
    const out = withRfiCosted([{ component: comp('3601', { countsAsRfi: true }), amount: 20_000 }, { component: comp('3817'), amount: 0, percentOfRfi: 0.15 }], warnings);
    expect(out[1]).toMatchObject({ amount: 3_000, rfiBase: 20_000 });
    expect(warnings).toEqual([]);
    withRfiCosted([{ component: comp('3606'), amount: 20_000 }, { component: comp('3817'), amount: 0, percentOfRfi: 0.15 }], warnings);
    expect(warnings.map((w) => w.code)).toEqual(['RFI_NIL']);
  });
});

describe('terminationMonthlySalary', () => {
  it('counts recurring earnings but not an employer fund contribution (3817 / 3825 / 3828)', async () => {
    const rows: EmployeeComponent[] = [
      { component: comp('3601'), amount: 20_000, isRecurring: true },
      { component: comp('3817'), amount: 3_000, isRecurring: true },
      { component: comp(' 3825 '), amount: 1_000, isRecurring: true },
      { component: comp('3828'), amount: 500, isRecurring: true },
      { component: comp('3606'), amount: 2_000, isRecurring: false },
    ];
    atExit.mockResolvedValueOnce(rows);
    expect(await terminationMonthlySalary('co', 'emp', '2026-03-31')).toBe(20_000);
  });
});

describe('terminationMonthlySalary with a pre-RF cash row (migration 975 opt-out)', () => {
  it('keeps it in the base, as before RF', async () => {
    atExit.mockResolvedValueOnce([
      { component: comp('3601'), amount: 20_000, isRecurring: true },
      { component: comp('3817'), amount: 3_000, isRecurring: true, employerFundAsCash: true },
    ]);
    expect(await terminationMonthlySalary('co', 'emp', '2026-03-31')).toBe(23_000);
  });
});
