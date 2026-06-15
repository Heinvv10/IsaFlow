/**
 * Pentest re-run H4 — permissions write has no membership pre-check.
 *
 * POST /api/accounting/permissions writes a company_user_permissions row for a
 * body-supplied `userId`. Before this fix the handler validated only that the
 * CALLER was an owner/admin of the active company — never that the TARGET userId
 * actually belonged to that company. A company-A admin could pre-seed elevated
 * module permissions for a company-B user (effective if they later join A).
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
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

vi.mock('@/lib/auth/permissionService', () => ({
  getPermissionModules: vi.fn(),
  getUserPermissions: vi.fn(),
  setUserModulePermission: vi.fn(),
  resetUserPermissions: vi.fn(),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), forbidden: vi.fn(),
    notFound: vi.fn(), methodNotAllowed: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import { getPermissionModules, setUserModulePermission } from '@/lib/auth/permissionService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/permissions';

const COMPANY_ID = '11111111-1111-4111-9111-111111111111';
const TARGET_USER = '44444444-4444-4444-9444-444444444444';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(): NextApiRequest {
  return {
    method: 'POST', query: {},
    body: { userId: TARGET_USER, moduleKey: 'invoices', canRead: true },
    companyId: COMPANY_ID, companyRole: 'admin',
    user: { id: 'caller' },
  } as unknown as NextApiRequest;
}
function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('permissions H4 — target-user membership guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getPermissionModules as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: 'invoices', moduleName: 'Invoices' },
    ]);
  });

  it('rejects when the target userId is NOT a member of the company', async () => {
    sqlMock.mockResolvedValue([]); // company_users membership lookup → empty
    await (handler as Handler)(makeReq(), makeRes());
    expect(setUserModulePermission).not.toHaveBeenCalled();
    expect(
      (apiResponse.notFound as ReturnType<typeof vi.fn>).mock.calls.length +
        (apiResponse.forbidden as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });

  it('allows when the target userId IS a member of the company', async () => {
    sqlMock.mockResolvedValue([{ ok: 1 }]); // company_users membership lookup → found
    await (handler as Handler)(makeReq(), makeRes());
    expect(setUserModulePermission).toHaveBeenCalledTimes(1);
  });
});
