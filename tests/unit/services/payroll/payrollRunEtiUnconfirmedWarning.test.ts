/**
 * calculatePayrollRun writes the ETI_TABLE_UNCONFIRMED warning into each line's
 * validation_results for a period from April 2026 with ETI > 0, and not before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserts: unknown[][] = [];
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
vi.mock('@/modules/accounting/services/payroll/payrollComponentService', () => ({
  getEmployeeComponents: vi.fn(async () => [{
    component: {
      id: 'c1', name: 'Salary', sarsSourceCode: '3601', componentType: 'earning',
      isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
    },
    amount: 3_000,
  }]),
}));
vi.mock('@/modules/accounting/services/payroll/sdlLeviabilityService', () => ({
  estimateAnnualRemuneration: vi.fn(async () => 0),
  applySdlToLines: vi.fn(() => 0),
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
});
