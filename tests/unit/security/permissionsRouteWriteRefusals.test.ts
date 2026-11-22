/**
 * #1656 round 7 (M4): POST and DELETE /api/accounting/permissions answer what the owner / admin check on the migration_admin pool
 * (memberWrites) refuses: a non-admin actor or an admin changing an owner is 403, a write that waited past the lock bound 409; any other
 * error is not swallowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/auth/permissionService', () => ({ getPermissionModules: vi.fn(async () => [{ moduleKey: 'suppliers', moduleName: 'S' }]), getMemberAccess: vi.fn(), getEffectivePermissions: vi.fn() }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userBelongsToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/memberWrites', async (orig) => ({
  ...(await orig<object>()),
  setMemberModulePermission: vi.fn(),
  resetMemberPermissions: vi.fn(),
}));

import { MemberRoleForbiddenError, resetMemberPermissions, setMemberModulePermission } from '@/modules/accounting/services/core/memberWrites';
import { OwnerProtectedError } from '@/modules/accounting/services/core/ownerLock';
import handler from '../../../pages/api/accounting/permissions';

const C = '11111111-1111-4111-8111-111111111111';
const T = '44444444-4444-4444-8444-444444444444';
const call = (method: string) => {
  const req = { method, query: { userId: T }, body: { userId: T, moduleKey: 'suppliers', canRead: true }, companyId: C, companyRole: 'admin', user: { id: 'actor' }, headers: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
};
beforeEach(() => vi.clearAllMocks());

describe.each([['POST', setMemberModulePermission], ['DELETE', resetMemberPermissions]] as const)('%s', (method, writer) => {
  it('is 200 when the write succeeds, and the writer is told who is acting', async () => {
    expect((await call(method)).statusCode).toBe(200);
    expect(vi.mocked(writer).mock.calls[0]).toContain('actor');
  });
  it('is 403 when the actor is not an owner / admin now, or an admin touches an owner', async () => {
    vi.mocked(writer).mockRejectedValueOnce(new MemberRoleForbiddenError());
    expect((await call(method)).statusCode).toBe(403);
    vi.mocked(writer).mockRejectedValueOnce(new OwnerProtectedError());
    expect((await call(method)).statusCode).toBe(403);
  });
  it('is 409 when the write waited past the lock bound (55P03) or lost a deadlock (40P01)', async () => {
    vi.mocked(writer).mockRejectedValueOnce(Object.assign(new Error('lock'), { code: '55P03' }));
    expect((await call(method)).statusCode).toBe(409);
    vi.mocked(writer).mockRejectedValueOnce(Object.assign(new Error('dead'), { code: '40P01' }));
    expect((await call(method)).statusCode).toBe(409);
  });
  it('does not swallow any other error', async () => {
    vi.mocked(writer).mockRejectedValueOnce(new Error('boom'));
    await expect(call(method)).rejects.toThrow('boom');
  });
});
