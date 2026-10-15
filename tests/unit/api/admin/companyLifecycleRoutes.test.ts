/**
 * Admin company lifecycle routes (delete / restore / activate / suspend):
 * a malformed id is a 400 before any SQL; a company the service refuses
 * (missing, or deleted where the action would undelete it) is a 404 with no
 * audit row; success writes the audit row. Services are mocked — the SQL rules
 * themselves are pinned in tests/integration/company-delete-restore.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const fx = vi.hoisted(() => ({ result: true }));
vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const service = {
  deleteCompany: vi.fn(async () => fx.result),
  restoreCompany: vi.fn(async () => fx.result),
  activateCompany: vi.fn(async () => fx.result),
  suspendCompany: vi.fn(async () => fx.result),
};
vi.mock('@/modules/admin/services/companyLifecycleService', () => ({
  deleteCompany: () => service.deleteCompany(),
  restoreCompany: () => service.restoreCompany(),
}));
vi.mock('@/modules/admin/services/adminCompanyService', () => ({
  activateCompany: () => service.activateCompany(),
  suspendCompany: () => service.suspendCompany(),
  getCompanyDetail: vi.fn(),
  updateCompany: vi.fn(),
}));
const logAdminAction = vi.fn(async () => undefined);
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: (...a: unknown[]) => logAdminAction(...(a as [])) }));

import deleteRoute from '../../../../pages/api/admin/companies/[id]';
import restoreRoute from '../../../../pages/api/admin/companies/[id]/restore';
import activateRoute from '../../../../pages/api/admin/companies/[id]/activate';
import suspendRoute from '../../../../pages/api/admin/companies/[id]/suspend';

const ID = '00000000-0000-4000-8000-0000000c0717';
type Route = (q: NextApiRequest, s: NextApiResponse) => Promise<void>;

async function call(route: unknown, method: string, id: unknown, body: unknown = {}) {
  const req = { method, query: { id }, body, user: { id: 'platform-admin' }, headers: {},
    socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(b: unknown) { state.body = b; return res; },
    setHeader() { return res; },
  } as unknown as NextApiResponse;
  await (route as Route)(req, res);
  return state;
}

const CASES = [
  { name: 'DELETE company', route: deleteRoute, method: 'DELETE', fn: service.deleteCompany, action: 'company.delete' },
  { name: 'restore', route: restoreRoute, method: 'POST', fn: service.restoreCompany, action: 'company.restore' },
  { name: 'activate', route: activateRoute, method: 'POST', fn: service.activateCompany, action: 'company.activate' },
  { name: 'suspend', route: suspendRoute, method: 'POST', fn: service.suspendCompany, action: 'company.suspend' },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  fx.result = true;
});

describe.each(CASES)('$name', ({ route, method, fn, action }) => {
  const body = { reason: 'unpaid' };

  it('400 on a malformed or repeated id, before the service runs', async () => {
    for (const id of ['not-a-uuid', [ID, ID], undefined]) {
      const r = await call(route, method, id, body);
      expect(r.statusCode).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('404 and no audit row when the service refuses the company', async () => {
    fx.result = false;
    const r = await call(route, method, ID, body);
    expect(r.statusCode).toBe(404);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('200 with the audit row on success', async () => {
    const r = await call(route, method, ID, body);
    expect(r.statusCode).toBe(200);
    expect(logAdminAction).toHaveBeenCalledTimes(1);
    expect((logAdminAction.mock.calls[0] as unknown[]).slice(0, 4)).toEqual(['platform-admin', action, 'company', ID]);
  });

  it('a service failure is thrown (rolled-back 500), never answered 4xx', async () => {
    fn.mockRejectedValueOnce(new Error('db down'));
    await expect(call(route, method, ID, body)).rejects.toThrow('db down');
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
