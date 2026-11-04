import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({
  withPayrollDetailAccess: (handler: unknown) => handler,
}));
vi.mock('@/modules/accounting/services/bank/bankControlRefusal', () => ({
  isHumanSession: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/modules/accounting/services/payroll/payrollBankReadAudit', () => ({
  auditBankDuplicatesRead: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollDuplicateDetectionService', () => ({
  findDuplicates: vi.fn().mockImplementation((_companyId: string, opts: { includeBankAccounts?: boolean }) =>
    Promise.resolve({
      idNumber: [], taxNumber: [], passportNumber: [], employeeNumber: [],
      bankAccount: opts.includeBankAccounts ? [{ value: '1234567890', employees: [] }] : [],
      totals: { totalConflicts: opts.includeBankAccounts ? 1 : 0, affectedEmployees: 0 },
    })),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(),
    methodNotAllowed: vi.fn(),
  },
}));

import handler from '../../../pages/api/payroll/duplicates';
import { apiResponse } from '@/lib/apiResponse';
import { isHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { auditBankDuplicatesRead } from '@/modules/accounting/services/payroll/payrollBankReadAudit';
import { findDuplicates } from '@/modules/accounting/services/payroll/payrollDuplicateDetectionService';

const COMPANY_ID = '11111111-1111-4111-9111-111111111111';
const res = {} as NextApiResponse;

function req(companyRole: string): NextApiRequest {
  return {
    method: 'GET', query: {}, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    companyId: COMPANY_ID, companyRole,
    user: { id: 'u1', email: 'u1@example.test' },
  } as unknown as NextApiRequest;
}

describe('GET /api/payroll/duplicates bank-account role gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not request or return bank-account groups for a manager', async () => {
    await (handler as unknown as (request: NextApiRequest, response: NextApiResponse) => Promise<void>)(req('manager'), res);

    expect(findDuplicates).toHaveBeenCalledWith(COMPANY_ID, {
      includeTerminated: false,
      includeBankAccounts: false,
      fullBankAccounts: false,
    });
    expect(isHumanSession).not.toHaveBeenCalled();
    expect(apiResponse.success).toHaveBeenCalledWith(res, expect.objectContaining({ bankAccount: [] }));
  });

  it.each(['owner', 'admin'])('lets a %s request bank-account groups', async (companyRole) => {
    await (handler as unknown as (request: NextApiRequest, response: NextApiResponse) => Promise<void>)(req(companyRole), res);

    expect(findDuplicates).toHaveBeenCalledWith(COMPANY_ID, {
      includeTerminated: false,
      includeBankAccounts: true,
      fullBankAccounts: true,
    });
  });

  it.each(['owner', 'admin'])('%s in a Login-as or token session: masked groups only, unaudited', async (companyRole) => {
    vi.mocked(isHumanSession).mockResolvedValueOnce(false);
    await (handler as unknown as (request: NextApiRequest, response: NextApiResponse) => Promise<void>)(req(companyRole), res);

    expect(isHumanSession).toHaveBeenCalledTimes(1);
    expect(findDuplicates).toHaveBeenCalledWith(COMPANY_ID, {
      includeTerminated: false,
      includeBankAccounts: true,
      fullBankAccounts: false,
    });
    expect(auditBankDuplicatesRead).not.toHaveBeenCalled();
  });
});
