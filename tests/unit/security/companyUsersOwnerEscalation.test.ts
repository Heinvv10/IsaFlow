/**
 * Pentest re-run H5 — company-users admin can self-promote to owner.
 *
 * PUT /api/accounting/company-users updates a user's role. Before this fix any
 * caller with companyRole 'admin' could set role='owner' for any user (incl.
 * themselves), acquiring full ownership. Only an existing owner may grant 'owner'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
  withWriteAccess: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));

vi.mock('@/modules/accounting/services/core/userAccessService', () => ({
  listCompanyUsers: vi.fn().mockResolvedValue([]),
  updateCompanyUserRole: vi.fn().mockResolvedValue(undefined),
  removeCompanyUser: vi.fn(),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), forbidden: vi.fn(),
    methodNotAllowed: vi.fn(), badRequestFromError: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import { updateCompanyUserRole } from '@/modules/accounting/services/core/userAccessService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/company-users';

const COMPANY_ID = '11111111-1111-4111-9111-111111111111';
const TARGET_USER = '44444444-4444-4444-9444-444444444444';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(companyRole: string, role: string): NextApiRequest {
  return {
    method: 'PUT', query: {},
    body: { userId: TARGET_USER, role },
    companyId: COMPANY_ID, companyRole,
    user: { id: 'caller' },
  } as unknown as NextApiRequest;
}
function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('company-users H5 — only owners can grant the owner role', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an admin promoting a user to owner', async () => {
    await (handler as Handler)(makeReq('admin', 'owner'), makeRes());
    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(updateCompanyUserRole).not.toHaveBeenCalled();
  });

  it('allows an owner to grant the owner role', async () => {
    await (handler as Handler)(makeReq('owner', 'owner'), makeRes());
    expect(apiResponse.forbidden).not.toHaveBeenCalled();
    expect(updateCompanyUserRole).toHaveBeenCalledTimes(1);
  });

  it('allows an admin to assign a non-owner role', async () => {
    await (handler as Handler)(makeReq('admin', 'manager'), makeRes());
    expect(apiResponse.forbidden).not.toHaveBeenCalled();
    expect(updateCompanyUserRole).toHaveBeenCalledTimes(1);
  });
});
