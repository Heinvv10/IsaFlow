/**
 * RFC 7591 dynamic client registration route — MCP Phase 1, Task 1.3.
 *
 * Contract under test (pages/api/oauth/register.ts):
 *  - valid registration → 201 with client_id and NO client_secret (public client)
 *  - redirect_uris missing/empty/non-https (except loopback) / >5 → 400
 *  - per-IP rate limit via the 'oauth-register' bucket, 10/hour
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/oauth', () => ({
  registerOauthApp: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => true),
  getClientIp: vi.fn(() => '203.0.113.9'),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth/oauthDynamicClients', () => ({
  pruneStaleDynamicApps: vi.fn(async () => 0),
}));

import { registerOauthApp } from '@/lib/auth/oauth';
import { checkRateLimit } from '@/lib/rateLimit';
import { pruneStaleDynamicApps } from '@/lib/auth/oauthDynamicClients';
import handler, { config as registerConfig } from '../../../pages/api/oauth/register';

const APP_ID = '44444444-4444-4444-4444-444444444444';

interface FakeRes {
  statusCode: number;
  body?: Record<string, unknown>;
}

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

function makeReq(body: unknown, method = 'POST'): NextApiRequest {
  return {
    method,
    body,
    headers: { 'content-type': 'application/json' },
    url: '/api/oauth/register',
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MCP_DCR_ENABLED = 'true';
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(registerOauthApp).mockResolvedValue({
    id: APP_ID,
    clientId: 'client_dynamic123',
    clientSecret: null,
  });
});

describe('POST /api/oauth/register', () => {
  it('valid registration → 201 with client_id and NO client_secret', async () => {
    const res = makeRes();
    await handler(
      makeReq({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }),
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(res.body!.client_id).toBe('client_dynamic123');
    expect(res.body!.client_name).toBe('Claude');
    expect(res.body!.token_endpoint_auth_method).toBe('none');
    expect(res.body!.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body).not.toHaveProperty('client_secret');
    expect(registerOauthApp).toHaveBeenCalledWith({
      ownerUserId: null,
      name: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      dynamic: true,
    });
  });

  it('missing or empty redirect_uris → 400', async () => {
    for (const body of [{}, { redirect_uris: [] }, { redirect_uris: 'not-an-array' }]) {
      const res = makeRes();
      await handler(makeReq(body), res);
      expect(res.statusCode).toBe(400);
      expect(res.body!.error).toBe('invalid_redirect_uri');
    }
    expect(registerOauthApp).not.toHaveBeenCalled();
  });

  it('non-https redirect URIs rejected — except RFC 8252 loopback', async () => {
    const bad = makeRes();
    await handler(makeReq({ redirect_uris: ['http://evil.example/cb'] }), bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.body!.error).toBe('invalid_redirect_uri');

    for (const loopback of ['http://localhost:53682/callback', 'http://127.0.0.1:9099/cb']) {
      const ok = makeRes();
      await handler(makeReq({ redirect_uris: [loopback] }), ok);
      expect(ok.statusCode).toBe(201);
    }
  });

  it('more than 5 redirect URIs → 400', async () => {
    const uris = Array.from({ length: 6 }, (_, i) => `https://client.example/cb${i}`);
    const res = makeRes();
    await handler(makeReq({ redirect_uris: uris }), res);
    expect(res.statusCode).toBe(400);
    expect(registerOauthApp).not.toHaveBeenCalled();
  });

  it('rate-limited per IP via the oauth-register bucket (10/hour) → 429 when exhausted', async () => {
    const res = makeRes();
    await handler(makeReq({ redirect_uris: ['https://client.example/cb'] }), res);
    expect(checkRateLimit).toHaveBeenCalledWith(
      'oauth-register:203.0.113.9',
      { max: 10, windowSecs: 3600 },
    );

    vi.mocked(checkRateLimit).mockResolvedValue(false);
    const limited = makeRes();
    await handler(makeReq({ redirect_uris: ['https://client.example/cb'] }), limited);
    expect(limited.statusCode).toBe(429);
    expect(registerOauthApp).toHaveBeenCalledTimes(1); // only the first, allowed request
  });

  it('enforces a GLOBAL registration cap even when the per-IP limit is fine', async () => {
    // per-IP bucket OK, global bucket exhausted → 429, no client minted
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => key !== 'oauth-register-global');
    const res = makeRes();
    await handler(makeReq({ redirect_uris: ['https://client.example/cb'] }), res);
    expect(checkRateLimit).toHaveBeenCalledWith('oauth-register-global', { max: 100, windowSecs: 3600 });
    expect(res.statusCode).toBe(429);
    expect(registerOauthApp).not.toHaveBeenCalled();
  });

  it('rejects a client_name that impersonates IsaFlow / claims official or verified status', async () => {
    for (const name of ['IsaFlow Official', 'isaflow support', 'Verified Partner', 'First-Party App']) {
      const res = makeRes();
      await handler(makeReq({ redirect_uris: ['https://c.example/cb'], client_name: name }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body!.error).toBe('invalid_client_metadata');
    }
    // legit names — including ones with generic words — are NOT blocked
    for (const name of ['Acme Bookkeeping Bot', 'Acme Billing Bot', 'Support Desk Connector']) {
      const ok = makeRes();
      await handler(makeReq({ redirect_uris: ['https://c.example/cb'], client_name: name }), ok);
      expect(ok.statusCode).toBe(201);
    }
  });

  // RFC 7591 §3.2.1 — the AS MAY replace requested metadata with the values it
  // will actually honour, and the client must use what comes back. claude.ai's
  // web connector asks for client_secret_post; rejecting that outright broke
  // "Connect" with an opaque "Couldn't register with IsaFlow's sign-in service".
  it('downgrades a requested confidential auth method to a public client instead of rejecting', async () => {
    for (const method of ['client_secret_post', 'client_secret_basic']) {
      const res = makeRes();
      await handler(
        makeReq({
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          client_name: 'Claude',
          token_endpoint_auth_method: method,
        }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(res.body!.token_endpoint_auth_method).toBe('none');
      expect(res.body).not.toHaveProperty('client_secret');
    }
    // never mint a secret-bearing client from an unauthenticated endpoint
    expect(vi.mocked(registerOauthApp).mock.calls.every(([args]) => args.dynamic === true)).toBe(true);
  });

  it('rejects unsupported grant/response types', async () => {
    const badGrant = makeRes();
    await handler(
      makeReq({ redirect_uris: ['https://c.example/cb'], grant_types: ['implicit'] }),
      badGrant,
    );
    expect(badGrant.statusCode).toBe(400);
    expect(badGrant.body!.error).toBe('invalid_client_metadata');

    const badResponse = makeRes();
    await handler(
      makeReq({ redirect_uris: ['https://c.example/cb'], response_types: ['token'] }),
      badResponse,
    );
    expect(badResponse.statusCode).toBe(400);
    expect(badResponse.body!.error).toBe('invalid_client_metadata');

    expect(registerOauthApp).not.toHaveBeenCalled();
  });

  it('non-POST → 405', async () => {
    const res = makeRes();
    await handler(makeReq(undefined, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });

  it('dark by default: 503 unless MCP_DCR_ENABLED=true (kill switch)', async () => {
    delete process.env.MCP_DCR_ENABLED;
    const res = makeRes();
    await handler(makeReq({ redirect_uris: ['https://client.example/cb'] }), res);
    expect(res.statusCode).toBe(503);
    expect(registerOauthApp).not.toHaveBeenCalled();
  });

  it('accepts the IPv6 loopback [::1] per RFC 8252', async () => {
    const res = makeRes();
    await handler(makeReq({ redirect_uris: ['http://[::1]:9099/cb'] }), res);
    expect(res.statusCode).toBe(201);
  });

  it('rejects an individual redirect URI longer than 512 chars', async () => {
    const res = makeRes();
    await handler(
      makeReq({ redirect_uris: [`https://client.example/${'a'.repeat(600)}`] }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body!.error).toBe('invalid_redirect_uri');
  });

  it('caps the request body via the exported bodyParser config', () => {
    expect(registerConfig).toEqual({ api: { bodyParser: { sizeLimit: '8kb' } } });
  });

  it('opportunistically prunes stale dynamic apps after a successful registration', async () => {
    const res = makeRes();
    await handler(makeReq({ redirect_uris: ['https://client.example/cb'] }), res);
    expect(res.statusCode).toBe(201);
    expect(pruneStaleDynamicApps).toHaveBeenCalledTimes(1);
  });
});
