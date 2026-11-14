/**
 * #1371 security LOW (WP9): PATCH /api/admin/users/[id] accepts `role: 'super_admin'` only as the target's
 * unchanged role (the edit form sends the role with every save). For anyone else it is a promotion: 400, and nothing
 * is written. For a super admin it is no role change: updateUser gets `role: undefined`. Runs on every CI; the guard
 * against the last super admin on a real database is in tests/integration/admin-super-admin-roster.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const m = vi.hoisted(() => ({
  roster: vi.fn(async (_id: string, _change: { keepsSuperAdmin: boolean }) =>
    ({ role: 'super_admin' as string | null, isSuperAdmin: true })),
  updateUser: vi.fn(async (_id: string, _data: Record<string, unknown>) => undefined),
  getUserDetail: vi.fn(async (id: string) => ({ id })),
  logAdminAction: vi.fn(async () => undefined),
}));
vi.mock('@/modules/admin/services/superAdminRosterService', () => ({
  assertSuperAdminRemains: m.roster,
  LastSuperAdminError: class extends Error {},
  LAST_SUPER_ADMIN_REASON: 'LAST_SUPER_ADMIN',
}));
vi.mock('@/modules/admin/services/adminUserService', () => ({ updateUser: m.updateUser, getUserDetail: m.getUserDetail }));
vi.mock('@/modules/admin/services/adminUserActionsService', () => ({ deleteUser: vi.fn(), SoleOwnerError: class extends Error {} }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: m.logAdminAction }));

import handler from '../../../../pages/api/admin/users/[id]';

async function patch(body: unknown) {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return res; },
    json(b: unknown) { state.body = b; return res; },
    setHeader() { return res; },
    getHeader() { return undefined; },
  } as unknown as NextApiResponse;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)({
    method: 'PATCH', query: { id: 'user-1' }, body, headers: {}, user: { id: 'admin-1' }, socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest, res);
  return state.status;
}

describe("PATCH users/[id] with role 'super_admin'", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('for a user who is not a super admin: 400, and nothing is updated or audited', async () => {
    m.roster.mockResolvedValueOnce({ role: 'admin', isSuperAdmin: false });
    expect(await patch({ role: 'super_admin', first_name: 'Nope' })).toBe(400);
    expect(m.roster).toHaveBeenCalledExactlyOnceWith('user-1', { keepsSuperAdmin: true });
    expect(m.updateUser).not.toHaveBeenCalled();
    expect(m.logAdminAction).not.toHaveBeenCalled();
  });

  it('for a super admin: no role change, updateUser gets role undefined with the other fields', async () => {
    expect(await patch({ role: 'super_admin', first_name: 'Renamed' })).toBe(200);
    expect(m.updateUser).toHaveBeenCalledExactlyOnceWith('user-1',
      { first_name: 'Renamed', last_name: undefined, role: undefined, phone: undefined });
  });

  it('a real demotion asks the roster guard with keepsSuperAdmin false and passes the new role on', async () => {
    expect(await patch({ role: 'admin' })).toBe(200);
    expect(m.roster).toHaveBeenCalledExactlyOnceWith('user-1', { keepsSuperAdmin: false });
    expect(m.updateUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ role: 'admin' }));
  });
});
