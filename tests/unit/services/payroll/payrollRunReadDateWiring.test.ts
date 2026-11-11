/**
 * calculatePayrollRun reads every employee's components on its period's last day (payrollRunReadDate), the same
 * calendar day whatever zone the process runs in. Before the fix it passed `new Date(year, month - 1, 28)` and the
 * reader turned that into the 27th on the SAST host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Both loan components exist: the fail-closed path has its own integration suites.
// Hein ruling R-A (wave 5 ET) has its own tests (etiPeriodGuard.test.ts): no later month posted here.
vi.mock('@/modules/accounting/services/payroll/etiPeriodGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/etiPeriodGuard')>()),
  laterEtiJournalRefusal: vi.fn(async () => null),
  earlierUnapprovedRefusal: vi.fn(async () => null),
  assertNoLaterEtiJournal: vi.fn(async () => undefined),
}));
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
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(() => Promise.resolve([]))),
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
  judgePayrollApproval: vi.fn(async () => ({ planHash: 'reviewed-plan' })),
}));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalAudit', () => ({
  recordPayRunApprovalAudit: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollComponentService', () => ({
  getEmployeeComponents: vi.fn(async () => []),
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
vi.mock('@/modules/accounting/services/payroll/payrollSeveranceDirective', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/payrollSeveranceDirective')>()),
  listSeveranceOnlyRunEmployees: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollRunEmployees: vi.fn(async () => [{
    id: 'e1', firstName: 'Thandi', lastName: 'Mokoena', employeeNumber: 'E1',
    dateOfBirth: new Date('1990-01-01'), startDate: new Date('2020-01-01'),
    uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
  }]),
  listTaxNumbersForCompany: vi.fn(async () => []),
}));

import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { getEmployeeComponents } from '@/modules/accounting/services/payroll/payrollComponentService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

async function readDateOfRun(month: number, year: number): Promise<unknown> {
  vi.mocked(getEmployeeComponents).mockClear();
  vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({
    id: 'r', company_id: 'c', status: 'draft', period_month: month, period_year: year,
  } as never);
  await calculatePayrollRun(RUN, COMPANY);
  expect(getEmployeeComponents).toHaveBeenCalledTimes(1);
  const [employeeId, companyId, asOf] = vi.mocked(getEmployeeComponents).mock.calls[0]!;
  expect([employeeId, companyId]).toEqual(['e1', COMPANY]);
  return asOf;
}

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe.each(['Africa/Johannesburg', 'UTC'] as const)('calculatePayrollRun with the process in %s', (zone) => {
  it.each([
    [3, 2026, '2026-03-31'],
    [4, 2026, '2026-04-30'],
    [2, 2026, '2026-02-28'],
    [12, 2026, '2026-12-31'],
  ])('period %i/%i reads components as at %s', async (month, year, expected) => {
    process.env.TZ = zone;
    expect(await readDateOfRun(month, year)).toBe(expected);
  });
});
