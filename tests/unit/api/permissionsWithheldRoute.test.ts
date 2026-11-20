/** #1656 round 3 (H1): the app's /api/accounting/permissions edits and shows company_users.approve_withheld (owner / admin only). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userBelongsToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/memberWrites', async (orig) => ({ ...(await orig<object>()), setMemberApproveWithheld: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/permissionService', async (orig) => ({
  ...(await orig<object>()),
  getMemberAccess: vi.fn(async () => ({ role: 'manager', approveWithheld: true })),
  getPermissionModules: vi.fn(async () => []), getEffectivePermissions: vi.fn(async () => []),
}));

import { getEffectivePermissions } from '@/lib/auth/permissionService';
import { MemberRoleForbiddenError, setMemberApproveWithheld } from '@/modules/accounting/services/core/memberWrites';
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
});
