/**
 * Pentest re-run M2 — payroll employees POST/PATCH missing withWriteAccess.
 *
 * employees/index.ts (POST) and employees/[id].ts (PATCH) were wrapped without
 * withWriteAccess, so a viewer-role user could create/edit employees. These tests
 * exercise the REAL withWriteAccess (only withAuth is mocked) to confirm a viewer
 * write is rejected while a manager write passes through, and viewer GET still works.
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
// NOTE: @/lib/auth/withWriteAccess is intentionally NOT mocked — we test the real gate.

vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollEmployees: vi.fn().mockResolvedValue([]),
  createPayrollEmployee: vi.fn().mockResolvedValue({ id: 'e1' }),
  getPayrollEmployee: vi.fn().mockResolvedValue({ id: 'e1' }),
  updatePayrollEmployee: vi.fn().mockResolvedValue({ id: 'e1' }),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), created: vi.fn(), badRequest: vi.fn(),
    forbidden: vi.fn(), notFound: vi.fn(), methodNotAllowed: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import {
  createPayrollEmployee, updatePayrollEmployee, listPayrollEmployees,
} from '@/modules/accounting/services/payroll/payrollEmployeeService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import indexHandler from '../../../pages/api/payroll/employees/index';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import detailHandler from '../../../pages/api/payroll/employees/[id]';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const VALID_BODY = {
  firstName: 'A', lastName: 'B', employeeNumber: 'E1',
  employmentType: 'permanent', startDate: '2026-01-01',
};

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}
function req(method: string, companyRole: string, extra: Record<string, unknown> = {}): NextApiRequest {
  return {
    method, query: { id: 'e1' }, body: VALID_BODY,
    companyId: '11111111-1111-4111-9111-111111111111', companyRole,
    user: { id: 'caller' }, ...extra,
  } as unknown as NextApiRequest;
}

describe('payroll employees M2 — write-access gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks a viewer from POST /employees', async () => {
    await (indexHandler as Handler)(req('POST', 'viewer'), makeRes());
    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(createPayrollEmployee).not.toHaveBeenCalled();
  });

  it('allows a manager to POST /employees', async () => {
    await (indexHandler as Handler)(req('POST', 'manager'), makeRes());
    expect(apiResponse.forbidden).not.toHaveBeenCalled();
    expect(createPayrollEmployee).toHaveBeenCalledTimes(1);
  });

  it('allows a viewer to GET /employees (read passes through)', async () => {
    await (indexHandler as Handler)(req('GET', 'viewer'), makeRes());
    expect(apiResponse.forbidden).not.toHaveBeenCalled();
    expect(listPayrollEmployees).toHaveBeenCalledTimes(1);
  });

  it('blocks a viewer from PATCH /employees/[id]', async () => {
    await (detailHandler as Handler)(req('PATCH', 'viewer'), makeRes());
    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(updatePayrollEmployee).not.toHaveBeenCalled();
  });

  it('allows a manager to PATCH /employees/[id]', async () => {
    await (detailHandler as Handler)(req('PATCH', 'manager'), makeRes());
    expect(apiResponse.forbidden).not.toHaveBeenCalled();
    expect(updatePayrollEmployee).toHaveBeenCalledTimes(1);
  });
});
