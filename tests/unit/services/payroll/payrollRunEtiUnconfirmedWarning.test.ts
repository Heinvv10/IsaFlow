/**
 * calculatePayrollRun writes the ETI_TABLE_UNCONFIRMED warning into each line's
 * validation_results for a period from April 2026 with ETI > 0, and not before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserts: unknown[][] = [];
// The year-to-date for cumulative PAYE (PAYE 4a follow-ups G4) has its own tests (p4fu-cumulative-paye).
// Both loan components exist: the fail-closed path has its own integration suites.
vi.mock('@/modules/accounting/services/payroll/fringeBenefitService', () => ({
  loadFringeBenefitsByEmployee: async () => new Map(),
  loadVehicleBenefitComponent: async () => null,
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLoanComponents', () => ({
  appendLoanComponents: (components: unknown[]) => components,
  loadLoanComponents: async () => ({ deduction: { id: 'loan' }, fringe: { id: 'fringe' } }),
}));
vi.mock('@/modules/accounting/services/payroll/payrollYearToDate', () => ({
  loadPayeYearToDate: vi.fn(async () => new Map()),
  laterPeriodsWarnings: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunRegularDirective', () => ({ loadRegularPayDirectives: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunDirectiveUses', () => ({ assertRunKeepsItsDirectives: vi.fn(async () => undefined) }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('INSERT INTO payroll_run_lines')) inserts.push(values);
      return Promise.resolve([]);
    })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  isPayrollRunLocked: () => false,
  lockCompanyPayrollApprovals: vi.fn(),
  lockPayrollRunHeader: vi.fn(),
  PayrollRunLockedError: class extends Error {},
  saveCalculatedRunTotals: vi.fn(async () => ({ id: 'r', company_id: 'c', status: 'calculated' })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLoanApplication', () => ({
  applyRunLoans: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({
  journalInForceOrNull: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalGate', () => ({
  judgePayrollApproval: vi.fn(async () => ({ planHash: 'plan-a' })),
}));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalAudit', () => ({
  recordPayRunApprovalAudit: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollComponentService', () => ({
  getEmployeeComponents: vi.fn(async () => [
    {
      component: {
        id: 'c1', name: 'Salary', sarsSourceCode: '3601', componentType: 'earning',
        isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
      },
      amount: 3_000,
    },
    {
      component: {
        id: 'c2', name: 'Loan fringe', sarsSourceCode: '3801', componentType: 'earning',
        isTaxable: true, isUifApplicable: false, isSdlApplicable: true,
      },
      amount: 100,
      isNonCash: true,
    },
  ]),
}));
// No recurring row needs a pro-rata (payroll-run-pro-rata-guard.int covers the guard).
vi.mock('@/modules/accounting/services/payroll/payrollRecurringProRata', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/payrollRecurringProRata')>()),
  recurringRowsNeedingProRata: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/payroll/sdlLeviabilityService', () => ({
  estimateAnnualRemuneration: vi.fn(async () => 0),
  applySdlToLines: vi.fn(() => 0),
}));
// No leaver awaiting a severance directive (p3-severance-directive-run covers that).
vi.mock('@/modules/accounting/services/payroll/payrollSeveranceDirective', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/payrollSeveranceDirective')>()),
  listSeveranceOnlyRunEmployees: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollRunEmployees: vi.fn(async () => [{
    id: 'e1', firstName: 'Thandi', lastName: 'Mokoena', employeeNumber: 'E1',
    dateOfBirth: new Date(2000, 0, 1), startDate: new Date(2026, 0, 1),
    uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
  }]),
  listTaxNumbersForCompany: vi.fn(async () => []),
}));

import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { listPayrollRunEmployees } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { estimateAnnualRemuneration } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import { getEmployeeComponents } from '@/modules/accounting/services/payroll/payrollComponentService';
import { laterPeriodsWarnings } from '@/modules/accounting/services/payroll/payrollYearToDate';

const codesWritten = (): string[] =>
  (JSON.parse(String(inserts[0]!.at(-1))) as Array<{ code: string }>).map((w) => w.code);

async function calculate(month: number, year: number) {
  vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({
    id: 'r', company_id: 'c', status: 'draft', period_month: month, period_year: year,
  } as never);
  await calculatePayrollRun('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
}

beforeEach(() => { inserts.length = 0; });

describe('calculatePayrollRun - unconfirmed ETI table warning', () => {
  it('writes ETI_TABLE_UNCONFIRMED for June 2026 when ETI is claimed', async () => {
    await calculate(6, 2026);
    expect(codesWritten()).toContain('ETI_TABLE_UNCONFIRMED');
  });

  it('writes nothing of the kind for March 2026', async () => {
    await calculate(3, 2026);
    expect(codesWritten()).not.toContain('ETI_TABLE_UNCONFIRMED');
  });

  it("reads the employees of the run's own company and period", async () => {
    await calculate(6, 2026);
    expect(listPayrollRunEmployees).toHaveBeenLastCalledWith(
      '11111111-1111-4111-8111-111111111111', { month: 6, year: 2026 },
    );
  });

  it('includes non-cash remuneration in the employer SDL threshold basis', async () => {
    await calculate(6, 2026);
    expect(estimateAnnualRemuneration).toHaveBeenLastCalledWith(
      '11111111-1111-4111-8111-111111111111', { month: 6, year: 2026 }, 3_100,
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('warns a fully donated salary line when a later period is approved', async () => {
    vi.mocked(getEmployeeComponents).mockResolvedValueOnce([
      {
        component: {
          id: 'salary', name: 'Salary', sarsSourceCode: '3601', componentType: 'earning',
          isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
        },
        amount: 20_000,
      },
      {
        component: {
          id: 'donation', name: 'Donation', sarsSourceCode: '4030', componentType: 'deduction',
          isTaxable: true, isUifApplicable: false, isSdlApplicable: false,
        },
        amount: 20_000,
      },
    ] as never);
    vi.mocked(laterPeriodsWarnings).mockResolvedValueOnce(new Map([['e1', {
      code: 'PAYE_LATER_PERIODS_APPROVED', severity: 'warning', periods: ['2027-02'], message: 'later',
    }]]));

    await calculate(1, 2027);

    expect(codesWritten()).toContain('PAYE_LATER_PERIODS_APPROVED');
  });
});
