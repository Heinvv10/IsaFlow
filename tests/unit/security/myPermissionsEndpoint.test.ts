/**
 * GET /api/accounting/my-permissions: the caller's own effective module permissions, for the nav.
 * Company and user come from the session (withAuth), never from the query string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/myPermissions', () => ({ getMyModulePermissions: vi.fn() }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), forbidden: vi.fn(), methodNotAllowed: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import { getMyModulePermissions } from '@/lib/auth/myPermissions';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/my-permissions';

const CO = '11111111-1111-4111-9111-111111111111';
const OTHER_CO = '33333333-3333-4333-9333-333333333333';
const OTHER_USER = '44444444-4444-4444-9444-444444444444';
type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const res = {} as NextApiResponse;

function req(over: Record<string, unknown> = {}): NextApiRequest {
  return { method: 'GET', query: {}, companyId: CO, companyRole: 'manager', user: { id: 'caller' }, ...over } as unknown as NextApiRequest;
}

describe('GET /api/accounting/my-permissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers the session's company and user, and returns the modules map", async () => {
    const modules = { payroll: { read: false, write: false, approve: false } };
    vi.mocked(getMyModulePermissions).mockResolvedValue(modules);
    await (handler as unknown as Handler)(req(), res);
    expect(getMyModulePermissions).toHaveBeenCalledWith(CO, 'caller');
    expect(apiResponse.success).toHaveBeenCalledWith(res, { modules });
  });

  it('ignores companyId and userId in the query string', async () => {
    vi.mocked(getMyModulePermissions).mockResolvedValue({});
    await (handler as unknown as Handler)(req({ query: { companyId: OTHER_CO, userId: OTHER_USER } }), res);
    expect(getMyModulePermissions).toHaveBeenCalledWith(CO, 'caller');
  });

  it('refuses a request with no user or company in the session', async () => {
    await (handler as unknown as Handler)(req({ user: undefined }), res);
    expect(apiResponse.forbidden).toHaveBeenCalled();
    expect(getMyModulePermissions).not.toHaveBeenCalled();
  });

  it('is GET only', async () => {
    await (handler as unknown as Handler)(req({ method: 'POST' }), res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalledWith(res, 'POST', ['GET']);
    expect(getMyModulePermissions).not.toHaveBeenCalled();
  });
});
