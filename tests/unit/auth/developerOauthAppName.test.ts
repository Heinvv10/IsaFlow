/**
 * POST /api/developer/oauth-apps — the route the reserved-name rule forgot.
 *
 * The rule was enforced only on the RFC 7591 endpoint. This route validated the
 * name's LENGTH and wrote it straight to oauth_apps, and the consent screen
 * renders app.name identically whether the app is dynamic or not — so a
 * signed-in user could register an app called plainly "IsaFlow" and have the
 * screen read "IsaFlow would like to access your ISAFlow account". No Unicode
 * trick; the control was simply absent here.
 *
 * It is authenticated, which is a higher bar than anonymous DCR, but signup is
 * self-serve.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth/oauth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/oauth')>()),
  registerOauthApp: vi.fn(async () => ({ id: 'app-1', clientId: 'client_x', clientSecret: 'cls_y' })),
  listOauthApps: vi.fn(async () => []),
}));

import { registerOauthApp } from '@/lib/auth/oauth';
import handler from '../../../pages/api/developer/oauth-apps/index';

interface FakeRes { statusCode: number; body?: Record<string, unknown> }
function makeRes(): NextApiResponse & FakeRes {
  const res = {
    statusCode: 200,
    body: undefined as FakeRes['body'],
    setHeader() { return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: FakeRes['body']) { res.body = b; return res; },
  };
  return res as unknown as NextApiResponse & FakeRes;
}
const makeReq = (name: string) => ({
  method: 'POST',
  body: { name, redirectUris: ['https://client.example/cb'] },
  headers: { 'content-type': 'application/json' },
  user: { id: 'user-1' },
}) as never;

beforeEach(() => vi.clearAllMocks());

describe('POST /api/developer/oauth-apps — reserved names', () => {
  it('refuses a name that impersonates the brand', async () => {
    for (const name of ['IsaFlow', 'IsaFlow Connector', 'OfficialIsaFlow', 'Isa Flow']) {
      vi.mocked(registerOauthApp).mockClear();
      const res = makeRes();
      await handler(makeReq(name), res);
      expect(res.statusCode, name).toBe(400);
      expect(registerOauthApp, name).not.toHaveBeenCalled();
    }
  });

  it('still accepts an ordinary name', async () => {
    const res = makeRes();
    await handler(makeReq('Acme Bookkeeping'), res);
    expect(res.statusCode).toBe(201);
    expect(registerOauthApp).toHaveBeenCalled();
  });

  // Stored must equal compared, as on the other route.
  it('normalises the stored name to NFC', async () => {
    const res = makeRes();
    await handler(makeReq('Acme𢡊Books'), res);
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(registerOauthApp).mock.calls[0]?.[0].name).toBe('Acme\u{2284A}Books');
  });
});
