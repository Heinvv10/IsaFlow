/**
 * D1 — an employee created without an explicit medical-aid answer is NOT a
 * medical-aid main member. A main member earns a monthly medical tax credit in
 * PAYE; defaulting to true under-deducted PAYE for every employee captured
 * without medical aid. Only an explicit `true` makes a main member, on every
 * path that creates a payroll_employees row (API, MCP tool, form), and an
 * update that omits the field must leave the stored value alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollEmployees: vi.fn().mockResolvedValue([]),
  createPayrollEmployee: vi.fn().mockResolvedValue({
    id: 'e1', employeeNumber: 'E1', firstName: 'A', lastName: 'B',
    employmentType: 'permanent', startDate: new Date(2026, 0, 1),
  }),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), created: vi.fn(), badRequest: vi.fn(),
    forbidden: vi.fn(), notFound: vi.fn(), methodNotAllowed: vi.fn(),
  },
}));

import { createPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { createEmployeeTool } from '@/lib/mcp/tools/writeEmployees';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollEmployee, PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';
import type { McpToolContext } from '@/lib/mcp/types';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import indexHandler from '../../../pages/api/payroll/employees/index';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BASE_BODY = {
  firstName: 'A', lastName: 'B', employeeNumber: 'E1',
  employmentType: 'permanent', startDate: '2026-01-01',
};

function postApi(extra: Record<string, unknown> = {}) {
  const req = {
    method: 'POST', query: {}, body: { ...BASE_BODY, ...extra },
    companyId: COMPANY, companyRole: 'owner', user: { id: 'u1' },
  } as unknown as NextApiRequest;
  return (indexHandler as Handler)(req, {} as NextApiResponse);
}

function createdWith(): PayrollEmployee {
  const calls = vi.mocked(createPayrollEmployee).mock.calls;
  return calls[calls.length - 1]![1] as PayrollEmployee;
}

describe('POST /api/payroll/employees — medical-aid main member', () => {
  beforeEach(() => vi.clearAllMocks());

  it('field absent → not a main member', async () => {
    await postApi();
    expect(createdWith().medicalAidMainMember).toBe(false);
  });

  it('explicit true → main member', async () => {
    await postApi({ medicalAidMainMember: true });
    expect(createdWith().medicalAidMainMember).toBe(true);
  });

  it.each([[false], [null], ['true'], [1], ['']])('%j → not a main member (only boolean true counts)', async (v) => {
    await postApi({ medicalAidMainMember: v });
    expect(createdWith().medicalAidMainMember).toBe(false);
  });
});

describe('create_employee MCP tool — medical-aid main member', () => {
  beforeEach(() => vi.clearAllMocks());
  const ctx = { userId: 'u', companyId: COMPANY, scopes: ['write:payroll'], tokenJti: 'j', oauthAppId: null } as McpToolContext;
  const args = (over: Record<string, unknown> = {}) => ({
    employee_number: 'E1', first_name: 'A', last_name: 'B', employment_type: 'permanent',
    start_date: '2026-01-01', idempotency_key: 'k', ...over,
  });

  it('argument absent → not a main member', async () => {
    await createEmployeeTool.handler(args(), ctx);
    expect(createdWith().medicalAidMainMember).toBe(false);
  });

  it('explicit true → main member', async () => {
    await createEmployeeTool.handler(args({ medical_aid_main_member: true }), ctx);
    expect(createdWith().medicalAidMainMember).toBe(true);
  });
});

describe('a default-created employee gets no medical tax credit', () => {
  function line(medicalAidMainMember: boolean) {
    const input: PayrollLineInput = {
      employee: {
        id: 'e1', companyId: COMPANY, employeeNumber: 'E1', firstName: 'A', lastName: 'B',
        employmentType: 'permanent', startDate: new Date('2023-01-01'),
        dateOfBirth: new Date('1990-01-01'), uifExcluded: false,
        medicalAidMainMember, medicalAidDependantsCount: 0,
      },
      components: [{
        component: {
          id: 'c1', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning',
          isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
        },
        amount: 30_000,
      }],
      period: { month: 6, year: 2025 },
      taxYear: 2026,
      annualPayrollEstimate: 1_000_000,
    };
    return calculatePayrollLine(input);
  }

  it('API-default employee: medicalCreditsApplied is 0 and PAYE is higher than a main member’s', async () => {
    await postApi();
    const { medicalAidMainMember } = createdWith();
    const defaulted = line(medicalAidMainMember);
    const member = line(true);
    expect(defaulted.paye.medicalCreditsApplied).toBe(0);
    expect(member.paye.medicalCreditsApplied).toBeGreaterThan(0);
    expect(defaulted.paye.monthlyPaye).toBeGreaterThan(member.paye.monthlyPaye);
  });
});
