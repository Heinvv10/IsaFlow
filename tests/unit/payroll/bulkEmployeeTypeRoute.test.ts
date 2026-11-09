/** POST /api/payroll/employees/bulk/apply: an employment type is judged against the enum (no director) and needs the role that may change pay terms (TS-b). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withCsrf: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), badRequest: vi.fn(), forbidden: vi.fn(), methodNotAllowed: vi.fn() },
}));
vi.mock('@/modules/accounting/services/payroll/payrollBulkEmployeeService', async (importOriginal) => ({
  ...await importOriginal<object>(), applyBulkEmployeeUpdate: vi.fn(async () => ({ updated: 1 })),
}));

import { apiResponse } from '@/lib/apiResponse';
import { applyBulkEmployeeUpdate } from '@/modules/accounting/services/payroll/payrollBulkEmployeeService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/
import handler from '../../../pages/api/payroll/employees/bulk/apply';

const call = (role: string, update: Record<string, unknown>) => (handler as H)({
  method: 'POST', body: { filter: { department: 'OPS' }, update }, companyId: 'c1', companyRole: role, user: { id: 'u1' },
} as unknown as NextApiRequest, {} as NextApiResponse);

beforeEach(() => vi.clearAllMocks());

describe('bulk apply, employment type', () => {
  it('a director is refused as a bad request, nothing written', async () => {
    await call('owner', { employmentType: 'director' });
    expect(apiResponse.badRequest).toHaveBeenCalled();
    expect(applyBulkEmployeeUpdate).not.toHaveBeenCalled();
  });

  it('a manager changing the employment type is forbidden, nothing written', async () => {
    await call('manager', { employmentType: 'casual' });
    expect(apiResponse.forbidden).toHaveBeenCalled();
    expect(applyBulkEmployeeUpdate).not.toHaveBeenCalled();
  });

  it('an owner and an admin may set permanent, contract or casual', async () => {
    for (const role of ['owner', 'admin']) await call(role, { employmentType: 'contract' });
    expect(applyBulkEmployeeUpdate).toHaveBeenCalledTimes(2);
  });

  it('a manager changing only the department is not affected', async () => {
    await call('manager', { department: 'ADMIN' });
    expect(applyBulkEmployeeUpdate).toHaveBeenCalledTimes(1);
  });
});
