/**
 * Token endpoint — public (dynamic) client behaviour. MCP Phase 1, Task 1.3.
 * (Plan wanted this in oauth.test.ts; split out to respect the 300-line cap.)
 *
 * Contract under test (pages/api/oauth/token.ts):
 *  - public client (no stored secret): auth-code grant succeeds WITHOUT
 *    client_secret, but the PKCE verifier remains mandatory
 *  - confidential client: secret still demanded (401 without it)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// S-07c (migration 930): the code consume + token insert run on the migration_admin pool.
const { adminQueryMock } = vi.hoisted(() => ({ adminQueryMock: vi.fn() }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminPool: () => ({ query: adminQueryMock }),
  migrationAdminTx: (_label: string, fn: (c: unknown) => unknown) => fn({ query: adminQueryMock }),
}));
vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => true),
  getClientIp: vi.fn(() => '203.0.113.9'),
  withRateLimit: (h: unknown) => h,
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../../pages/api/oauth/token';
import { resetSqlMock, mockSqlOnce } from './helpers';

const APP_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = 'user-gotrue-1';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';

function appRow(isConfidential: boolean): Record<string, unknown> {
  return {
    id: APP_ID, name: 'Claude', description: null, logo_url: null, homepage_url: null,
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    client_id: 'client_dynamic123', is_verified: false, is_first_party: false,
    is_confidential: isConfidential,
  };
}

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

function makeReq(body: Record<string, unknown>): NextApiRequest {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    url: '/api/oauth/token',
  } as unknown as NextApiRequest;
}

function mockAdminOnce(rows: unknown[]): void {
  adminQueryMock.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

beforeEach(() => {
  resetSqlMock();
  adminQueryMock.mockReset();
  adminQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /api/oauth/token — public (PKCE-only) clients', () => {
  const grant = {
    grant_type: 'authorization_code',
    client_id: 'client_dynamic123',
    code: `oac_${'C'.repeat(32)}`,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_verifier: 'a-perfectly-fine-pkce-verifier-string',
  };

  it('exchanges a code WITHOUT client_secret when the app is public', async () => {
    mockSqlOnce([appRow(false)]); // getOauthAppByClientId
    mockSqlOnce([{ '?column?': 1 }]); // the service-pool pre-read finds the code (S-07c)
    mockAdminOnce([{ user_id: USER_ID, company_id: COMPANY_ID, scopes: ['read:reports'] }]); // consume
    const res = makeRes();
    await handler(makeReq(grant), res);

    expect(res.statusCode).toBe(200);
    expect(String(res.body!.access_token)).toMatch(/^oat_/);
    expect(res.body!.token_type).toBe('Bearer');
    expect(res.body!.scope).toBe('read:reports');
  });

  it('still requires the PKCE verifier for public clients', async () => {
    mockSqlOnce([appRow(false)]);
    const res = makeRes();
    const { code_verifier: _omitted, ...noVerifier } = grant;
    await handler(makeReq(noVerifier), res);
    expect(res.statusCode).toBe(400);
    expect(res.body!.error).toBe('invalid_request');
  });

  // FB-4 (RFC 8707): a token is only ever for /api/mcp.
  it('a wrong resource → 400 invalid_target, before any code is consumed', async () => {
    for (const resource of ['https://evil.example/api/mcp', ['https://app.isaflow.co.za/api/mcp', 'https://x.example']]) {
      resetSqlMock();
      adminQueryMock.mockClear();
      mockSqlOnce([appRow(false)]);
      const res = makeRes();
      await handler(makeReq({ ...grant, resource }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body!.error).toBe('invalid_target');
      expect(adminQueryMock).not.toHaveBeenCalled();
    }
  });

  it('the right resource (path or bare origin) → 200', async () => {
    for (const resource of ['https://app.isaflow.co.za/api/mcp', 'https://app.isaflow.co.za']) {
      resetSqlMock();
      adminQueryMock.mockClear();
      mockSqlOnce([appRow(false)]);
      mockSqlOnce([{ '?column?': 1 }]);
      mockAdminOnce([{ user_id: USER_ID, company_id: COMPANY_ID, scopes: ['read:reports'] }]);
      const res = makeRes();
      await handler(makeReq({ ...grant, resource }), res);
      expect(res.statusCode, resource).toBe(200);
    }
  });

  it('a wrong resource in a form-encoded body → 400 invalid_target', async () => {
    mockSqlOnce([appRow(false)]);
    const res = makeRes();
    const req = { ...makeReq({ ...grant, resource: 'https://evil.example/api/mcp' }) } as unknown as Record<string, unknown>;
    req.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    await handler(req as unknown as NextApiRequest, res);
    expect(res.statusCode).toBe(400);
    expect(res.body!.error).toBe('invalid_target');
  });

  it('confidential clients still get 401 without their client_secret', async () => {
    mockSqlOnce([appRow(true)]);
    const res = makeRes();
    await handler(makeReq(grant), res);
    expect(res.statusCode).toBe(401);
    expect(res.body!.error).toBe('invalid_client');
  });
});
