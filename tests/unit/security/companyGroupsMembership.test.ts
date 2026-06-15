/**
 * Pentest re-run H1 — company-groups cross-tenant IDOR.
 *
 * The POST actions add-member / auto-generate-coa / set-mapping / auto-map take a
 * `companyId` (or `sourceCompanyId`) from the request body. Before this fix the
 * handler only verified the caller belonged to the *group* (verifyGroupAccess) —
 * never that the caller belonged to the *company* being added/read. An authenticated
 * user could link an arbitrary tenant into their consolidation group and read its
 * COA/financials. These tests assert the new per-company membership guard.
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

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => ({
  getGroup: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
  addMember: vi.fn(), updateMember: vi.fn(), removeMember: vi.fn(), getGroupMembers: vi.fn(),
  getGroupAccounts: vi.fn(), createGroupAccount: vi.fn(), updateGroupAccount: vi.fn(),
  deleteGroupAccount: vi.fn(), autoGenerateGroupCOA: vi.fn(), getCoaMappings: vi.fn(),
  setCoaMapping: vi.fn(), removeCoaMapping: vi.fn(), autoMapAccounts: vi.fn(),
  getUnmappedAccounts: vi.fn(),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), forbidden: vi.fn(),
    notFound: vi.fn(), methodNotAllowed: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import {
  addMember, autoGenerateGroupCOA, setCoaMapping, autoMapAccounts,
} from '@/modules/accounting/services/reports/groupCompanyService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/company-groups';

const USER_ID = '11111111-1111-4111-9111-111111111111';
const GROUP_ID = '22222222-2222-4222-9222-222222222222';
const OTHER_COMPANY = '33333333-3333-4333-9333-333333333333';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

/** Route sql calls: group-access query vs company_users membership query. */
function wireSql(opts: { hasGroupAccess: boolean; isCompanyMember: boolean }): void {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('company_group_members')) {
      return Promise.resolve(opts.hasGroupAccess ? [{ ok: 1 }] : []);
    }
    // SELECT 1 FROM company_users WHERE company_id = ... AND user_id = ...
    return Promise.resolve(opts.isCompanyMember ? [{ ok: 1 }] : []);
  });
}

function makeReq(body: Record<string, unknown>): NextApiRequest {
  return { method: 'POST', query: {}, body, user: { id: USER_ID } } as unknown as NextApiRequest;
}
function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('company-groups H1 — per-company membership guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('add-member: rejects a company the caller is NOT a member of', async () => {
    wireSql({ hasGroupAccess: true, isCompanyMember: false });
    await (handler as Handler)(
      makeReq({ action: 'add-member', groupId: GROUP_ID, companyId: OTHER_COMPANY }),
      makeRes(),
    );
    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(addMember).not.toHaveBeenCalled();
  });

  it('add-member: allows a company the caller IS a member of', async () => {
    wireSql({ hasGroupAccess: true, isCompanyMember: true });
    await (handler as Handler)(
      makeReq({ action: 'add-member', groupId: GROUP_ID, companyId: OTHER_COMPANY }),
      makeRes(),
    );
    expect(apiResponse.forbidden).not.toHaveBeenCalled();
    expect(addMember).toHaveBeenCalledTimes(1);
  });

  it('auto-generate-coa: rejects a sourceCompanyId the caller is NOT a member of', async () => {
    wireSql({ hasGroupAccess: true, isCompanyMember: false });
    await (handler as Handler)(
      makeReq({ action: 'auto-generate-coa', groupId: GROUP_ID, sourceCompanyId: OTHER_COMPANY }),
      makeRes(),
    );
    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(autoGenerateGroupCOA).not.toHaveBeenCalled();
  });

  it('set-mapping: rejects a companyId the caller is NOT a member of', async () => {
    wireSql({ hasGroupAccess: true, isCompanyMember: false });
    await (handler as Handler)(
      makeReq({
        action: 'set-mapping', groupId: GROUP_ID, companyId: OTHER_COMPANY,
        companyAccountId: 'a', groupAccountId: 'b',
      }),
      makeRes(),
    );
    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(setCoaMapping).not.toHaveBeenCalled();
  });

  it('auto-map: rejects a companyId the caller is NOT a member of', async () => {
    wireSql({ hasGroupAccess: true, isCompanyMember: false });
    await (handler as Handler)(
      makeReq({ action: 'auto-map', groupId: GROUP_ID, companyId: OTHER_COMPANY }),
      makeRes(),
    );
    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(autoMapAccounts).not.toHaveBeenCalled();
  });
});
