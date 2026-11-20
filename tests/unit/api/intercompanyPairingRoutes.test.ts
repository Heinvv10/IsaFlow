/**
 * The pairing routes (P3): a method they do not serve is a 405, an id or a body that is not well formed is a 400 before any
 * query, a service refusal keeps its status, and the session user and company reach the service with lower-cased ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const svc = vi.hoisted(() => ({ createPairings: vi.fn(), confirmPairing: vi.fn(), unlinkPairing: vi.fn(), buildPairingView: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/pairingWrite', () => ({
  createPairings: svc.createPairings, confirmPairing: svc.confirmPairing, unlinkPairing: svc.unlinkPairing,
}));
vi.mock('@/modules/accounting/services/intercompany/pairingView', () => ({ buildPairingView: svc.buildPairingView }));

import { sql } from '@/lib/neon';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const ID = '3333aaaa-3333-4333-8333-33333333bbbb';
const LINK = '4444aaaa-4444-4444-8444-44444444bbbb';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const load = async (route: string): Promise<H> => (await import(/* @vite-ignore */ `../../../pages/api/accounting/intercompany/connections/[id]/${route}`)).default as H;
function makeRes() {
  const res = { statusCode: 200, body: undefined as { error?: { message?: string }; data?: unknown } | undefined, setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; }, json(b: typeof res.body) { res.body = b; return res; } };
  return res;
}
const req = (method: string, query: Record<string, unknown>, body: unknown = undefined, role = 'owner') => ({
  method, headers: {}, cookies: {}, query, body, companyId: COMPANY, companyRole: role, user: { id: 'u-1' },
}) as unknown as NextApiRequest;
const PAIR = { mineId: ID, theirsId: LINK };

beforeEach(() => { vi.mocked(sql).mockClear(); Object.values(svc).forEach((f) => f.mockReset()); });

describe('pairing', () => {
  it.each(['PUT', 'DELETE', 'PATCH'])('%s is a 405', async (method) => {
    const res = makeRes();
    await (await load('pairing'))(req(method, { id: ID }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(405);
  });

  it.each([['nope'], [['a', 'b']], [undefined]])('GET with the id %j is a 400, nothing called', async (id) => {
    const res = makeRes();
    await (await load('pairing'))(req('GET', { id, direction: 'ar' }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(400);
    expect(svc.buildPairingView).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['up'], [['ar', 'ap']]])('GET with the direction %j is a 400', async (direction) => {
    const res = makeRes();
    await (await load('pairing'))(req('GET', { id: ID, direction }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(400);
    expect(svc.buildPairingView).not.toHaveBeenCalled();
  });

  it('GET passes the user, company, lower-cased id and direction on', async () => {
    svc.buildPairingView.mockResolvedValue({ blocked: null });
    const res = makeRes();
    await (await load('pairing'))(req('GET', { id: ID.toUpperCase(), direction: 'ap' }), res as unknown as NextApiResponse);
    expect(svc.buildPairingView).toHaveBeenCalledWith('u-1', COMPANY, ID, 'ap');
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [null], [[]], [{ direction: 'ar' }], [{ direction: 'ar', pairs: [] }], [{ direction: 'ar', pairs: [PAIR], extra: 1 }],
    [{ direction: 'ar', pairs: [{ mineId: 'x', theirsId: LINK }] }], [{ direction: 'ar', pairs: [{ ...PAIR, extra: 1 }] }],
    [{ direction: 'ar', pairs: [PAIR, PAIR] }], [{ direction: 'ar', pairs: [PAIR, { mineId: LINK, theirsId: crypto.randomUUID() }] }],
    [{ direction: 'ar', pairs: Array.from({ length: 201 }, () => ({ mineId: crypto.randomUUID(), theirsId: crypto.randomUUID() })) }],
  ])('POST with the body %j is a 400, nothing called', async (body) => {
    const res = makeRes();
    await (await load('pairing'))(req('POST', { id: ID }, body), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(400);
    expect(svc.createPairings).not.toHaveBeenCalled();
  });

  it('POST records the pairs with lower-cased ids and answers 201; a refusal keeps its status; a crash is rethrown', async () => {
    svc.createPairings.mockResolvedValue({ created: 1, active: 0 });
    let res = makeRes();
    await (await load('pairing'))(req('POST', { id: ID }, { direction: 'ar', pairs: [{ mineId: ID.toUpperCase(), theirsId: LINK }] }), res as unknown as NextApiResponse);
    expect(svc.createPairings).toHaveBeenCalledWith('u-1', COMPANY, ID, 'ar', [PAIR]);
    expect(res.statusCode).toBe(201);
    svc.createPairings.mockRejectedValue(new ConnectionRefusal(409, 'Gone.'));
    res = makeRes();
    await (await load('pairing'))(req('POST', { id: ID }, { direction: 'ar', pairs: [PAIR] }), res as unknown as NextApiResponse);
    expect([res.statusCode, res.body?.error?.message]).toEqual([409, 'Gone.']);
    svc.createPairings.mockRejectedValue(new Error('boom'));
    await expect((await load('pairing'))(req('POST', { id: ID }, { direction: 'ar', pairs: [PAIR] }), makeRes() as unknown as NextApiResponse)).rejects.toThrow('boom');
  });
});

describe('pairing/links/[linkId]', () => {
  it.each(['GET', 'POST'])('%s is a 405', async (method) => {
    const res = makeRes();
    await (await load('pairing/links/[linkId]'))(req(method, { id: ID, linkId: LINK }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(405);
  });

  it.each([[{ id: 'x', linkId: LINK }], [{ id: ID, linkId: 'x' }], [{ id: ID }]])('PUT and DELETE with %j are a 400', async (query) => {
    for (const method of ['PUT', 'DELETE']) {
      const res = makeRes();
      await (await load('pairing/links/[linkId]'))(req(method, query), res as unknown as NextApiResponse);
      expect(res.statusCode).toBe(400);
    }
    expect(svc.confirmPairing).not.toHaveBeenCalled();
    expect(svc.unlinkPairing).not.toHaveBeenCalled();
  });

  it('PUT confirms and DELETE unlinks, with the user, company and lower-cased ids; a refusal keeps its status', async () => {
    svc.confirmPairing.mockResolvedValue({ status: 'active' });
    svc.unlinkPairing.mockResolvedValue({ status: 'unlinked' });
    const h = await load('pairing/links/[linkId]');
    let res = makeRes();
    await h(req('PUT', { id: ID.toUpperCase(), linkId: LINK.toUpperCase() }), res as unknown as NextApiResponse);
    expect(svc.confirmPairing).toHaveBeenCalledWith('u-1', COMPANY, ID, LINK);
    res = makeRes();
    await h(req('DELETE', { id: ID, linkId: LINK }), res as unknown as NextApiResponse);
    expect(svc.unlinkPairing).toHaveBeenCalledWith('u-1', COMPANY, ID, LINK);
    svc.unlinkPairing.mockRejectedValue(new ConnectionRefusal(404, 'x'));
    res = makeRes();
    await h(req('DELETE', { id: ID, linkId: LINK }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(404);
  });
});
