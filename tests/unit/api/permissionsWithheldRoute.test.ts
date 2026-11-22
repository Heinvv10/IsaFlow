/** #1656 round 3 (H1): the app's /api/accounting/permissions edits and shows company_users.approve_withheld (owner / admin only). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userBelongsToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/memberWrites', async (orig) => ({
  ...(await orig<object>()), setMemberApproveWithheld: vi.fn(async () => undefined), resetMemberPermissions: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/permissionService', async (orig) => ({
  ...(await orig<object>()),
  getMemberAccess: vi.fn(async () => ({ role: 'manager', approveWithheld: true })),
  getPermissionModules: vi.fn(async () => []), getEffectivePermissions: vi.fn(async () => []),
}));

import { getEffectivePermissions, getMemberAccess } from '@/lib/auth/permissionService';
import { userBelongsToCompany } from '@/modules/accounting/services/core/companyAccessService';
import { MemberRoleForbiddenError, resetMemberPermissions, setMemberApproveWithheld } from '@/modules/accounting/services/core/memberWrites';
import { PayRunApproverProtectedError } from '@/modules/accounting/services/core/payRunApproverGuard';
import { OwnerProtectedError } from '@/modules/accounting/services/core/ownerLock';
import handler from '../../../pages/api/accounting/permissions';

const C = '11111111-1111-4111-8111-111111111111';
const T = '99999999-9999-4999-8999-999999999999';
const ACTOR = '55555555-5555-4555-8555-555555555555';

function call(method: string, body: unknown, role = 'owner', query: Record<string, string> = {}) {
  const req = { method, query, body, companyId: C, companyRole: role, user: { id: ACTOR } } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, setHeader() { return this; } };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
beforeEach(() => vi.clearAllMocks());

describe('approve_withheld on /api/accounting/permissions', () => {
  it('GET returns the flag and gives it to the effective grid', async () => {
    const res = await call('GET', undefined, 'owner', { userId: T });
    expect((res.sent as { data: { approveWithheld: boolean } }).data.approveWithheld).toBe(true);
    expect(getEffectivePermissions).toHaveBeenCalledWith(C, T, 'manager', true);
  });

  it('PUT by an owner sets it through the member-write pool, as that actor', async () => {
    const res = await call('PUT', { userId: T, approveWithheld: false });
    expect(res.statusCode).toBe(200);
    expect(setMemberApproveWithheld).toHaveBeenCalledWith(C, T, false, ACTOR);
  });

  it('PUT by a manager is refused 403, nothing written; a non-boolean is 400', async () => {
    expect((await call('PUT', { userId: T, approveWithheld: false }, 'manager')).statusCode).toBe(403);
    expect((await call('PUT', { userId: T, approveWithheld: 'no' })).statusCode).toBe(400);
    expect(setMemberApproveWithheld).not.toHaveBeenCalled();
  });

  it('the pool refusing the actor (RC001) is 403', async () => {
    vi.mocked(setMemberApproveWithheld).mockRejectedValueOnce(new MemberRoleForbiddenError());
    expect((await call('PUT', { userId: T, approveWithheld: true })).statusCode).toBe(403);
  });

  it('round 4: the pool refusing a change to an owner (OwnerProtectedError) is 403, not a 500', async () => {
    vi.mocked(setMemberApproveWithheld).mockRejectedValueOnce(new OwnerProtectedError());
    expect((await call('PUT', { userId: T, approveWithheld: true }, 'admin')).statusCode).toBe(403);
  });

  // #1670 Codex: company_users.user_id is TEXT; a member with a non-UUID id is looked up by company, never refused as "not a UUID".
  it('a member whose user id is not a UUID: GET shows the grid, PUT withholds, DELETE resets', async () => {
    const TEXT_ID = 'legacy-user-42';
    const got = await call('GET', undefined, 'owner', { userId: TEXT_ID });
    expect(got.statusCode).toBe(200);
    expect(getMemberAccess).toHaveBeenCalledWith(C, TEXT_ID);
    expect((await call('PUT', { userId: TEXT_ID, approveWithheld: true })).statusCode).toBe(200);
    expect(setMemberApproveWithheld).toHaveBeenCalledWith(C, TEXT_ID, true, ACTOR);
    expect((await call('DELETE', undefined, 'owner', { userId: TEXT_ID })).statusCode).toBe(200);
    expect(resetMemberPermissions).toHaveBeenCalledWith(C, TEXT_ID, ACTOR);
  });

  it('a user id that names no member of this company is 404 on DELETE too, before any write', async () => {
    vi.mocked(userBelongsToCompany).mockResolvedValueOnce(false);
    expect((await call('DELETE', undefined, 'owner', { userId: 'nobody' })).statusCode).toBe(404);
    expect(resetMemberPermissions).not.toHaveBeenCalled();
  });

  it('withholding that would strand a pending pay run is 409 (PayRunApproverProtectedError), not a 500', async () => {
    vi.mocked(setMemberApproveWithheld).mockRejectedValueOnce(new PayRunApproverProtectedError());
    const res = await call('PUT', { userId: T, approveWithheld: true });
    expect(res.statusCode).toBe(409);
    vi.mocked(resetMemberPermissions).mockRejectedValueOnce(new PayRunApproverProtectedError());
    expect((await call('DELETE', undefined, 'owner', { userId: T })).statusCode).toBe(409);
  });
});
