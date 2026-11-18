/**
 * The intercompany routes: a method they do not serve is a 405, an id that is not a UUID is a 400 before any query,
 * and a refusal from the service keeps its status. Only the auth wrappers are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const svc = vi.hoisted(() => ({ updateConnectionSettings: vi.fn(), updateOwnSide: vi.fn(), revokeConnection: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/connectionService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/intercompany/connectionService')>()), ...svc,
}));

import { sql } from '@/lib/neon';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const ID = '3333aaaa-3333-4333-8333-33333333bbbb';
const load = async (route: string): Promise<H> => (await import(/* @vite-ignore */ `../../../pages/api/accounting/intercompany/${route}`)).default as H;
function makeRes() {
  const res = { statusCode: 200, body: undefined as { error?: { message?: string } } | undefined, setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; }, json(b: typeof res.body) { res.body = b; return res; } };
  return res;
}
const req = (method: string, query: Record<string, unknown> = { id: ID }, body: unknown = { cutoverDate: null }) => ({
  method, headers: {}, cookies: {}, query, body, companyId: '11111111-1111-4111-8111-111111111111', companyRole: 'owner', user: { id: 'u-1' },
}) as unknown as NextApiRequest;

beforeEach(() => { vi.mocked(sql).mockClear(); Object.values(svc).forEach((f) => f.mockReset()); });

describe('methods', () => {
  it.each([
    ['side-options', 'POST'], ['side-options', 'DELETE'], ['group-candidates', 'POST'], ['group-candidates', 'PUT'],
    ['connections', 'PUT'], ['connections', 'DELETE'], ['connections/[id]', 'GET'], ['connections/[id]', 'POST'], ['connections/[id]/settings', 'GET'], ['connections/[id]/settings', 'DELETE'],
  ])('%s %s is a 405 with no query', async (route, method) => {
    const res = makeRes();
    await (await load(route))(req(method), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(405);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('ids and refusals', () => {
  it.each([['connections/[id]', 'PUT'], ['connections/[id]', 'DELETE'], ['connections/[id]/settings', 'PUT']])('%s %s with an id that is not a UUID is a 400, nothing called', async (route, method) => {
    for (const id of ['nope', ['a', 'b'], undefined, '1; DROP TABLE x']) {
      const res = makeRes();
      await (await load(route))(req(method, { id }), res as unknown as NextApiResponse);
      expect(res.statusCode).toBe(400);
    }
    expect(Object.values(svc).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('a service refusal keeps its status and sentence; a crash is rethrown, not answered', async () => {
    svc.updateConnectionSettings.mockRejectedValue(new ConnectionRefusal(403, 'Needs a role in both.'));
    let res = makeRes();
    await (await load('connections/[id]/settings'))(req('PUT'), res as unknown as NextApiResponse);
    expect([res.statusCode, res.body?.error?.message]).toEqual([403, 'Needs a role in both.']);
    svc.updateConnectionSettings.mockRejectedValue(new ConnectionRefusal(409, 'Revoked.'));
    res = makeRes();
    await (await load('connections/[id]/settings'))(req('PUT'), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(409);
    svc.updateConnectionSettings.mockRejectedValue(new Error('boom'));
    await expect((await load('connections/[id]/settings'))(req('PUT'), makeRes() as unknown as NextApiResponse)).rejects.toThrow('boom');
  });

  it('the ids are lower-cased before the service and the session user is passed on', async () => {
    svc.updateConnectionSettings.mockResolvedValue({ id: ID });
    const res = makeRes();
    await (await load('connections/[id]/settings'))(req('PUT', { id: ID.toUpperCase() }), res as unknown as NextApiResponse);
    expect(svc.updateConnectionSettings).toHaveBeenCalledWith('u-1', '11111111-1111-4111-8111-111111111111', ID, { cutoverDate: null });
    expect(res.statusCode).toBe(200);
  });
});
