/**
 * Strict Bearer-only wrapper coverage — MCP Phase 2, Task 2.3.
 *
 * Invariants:
 *  - no Authorization header → 401 + WWW-Authenticate challenge (never cookies)
 *  - a valid session cookie WITHOUT a Bearer token → still 401 (cookies ignored)
 *  - invalid/expired/unsupported Bearer → 401 + challenge
 *  - valid pat_/oat_ → identical pipeline behaviour to the dual wrapper
 *    (context attached, GUCs set, membership re-check holds)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiResponse } from 'next';

const h = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const client = { query: clientQuery, release: vi.fn() };
  const connect = vi.fn(async () => client);
  return { client, clientQuery, connect };
});

vi.mock('pg', () => ({
  default: {
    ...pgTypesMock(),
    Pool: class {
      connect = h.connect;
      on = vi.fn();
    },
  },
}));

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth/withAuth', () => ({
  withAuth: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/auth/personalAccessTokens', () => ({
  validatePat: vi.fn(),
}));

vi.mock('@/lib/auth/oauth', () => ({
  validateOauthAccessToken: vi.fn(),
}));

// Use real ALS so control lifetime/integrity gates are exercised.

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => true),
  getClientIp: vi.fn(() => '10.0.0.1'),
}));

vi.mock('@sentry/nextjs', () => ({
  withIsolationScope: vi.fn(async (cb: () => unknown) => cb()),
  setTag: vi.fn(),
}));

vi.mock('@/lib/sentry/tags', () => ({
  setTenantTags: vi.fn(),
  sanitizeRoute: vi.fn((r: string) => r),
}));

import { withAuth } from '@/lib/auth/withAuth';
import { validatePat } from '@/lib/auth/personalAccessTokens';
import { withBearerAuth } from '@/lib/auth/withBearerAuth';

const USER_ID = 'user-gotrue-1';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const PAT_ID = '33333333-3333-3333-3333-333333333333';
const RAW = `pat_${'A'.repeat(32)}`;

process.env.DATABASE_URL ||= 'postgres://unit-test-not-used';

interface FakeRes extends NextApiResponse {
  statusCode: number;
  body?: { success: boolean; error?: { code: string } };
  headers: Record<string, unknown>;
}

function makeReq(headers: Record<string, string> = {}): Record<string, unknown> {
  return { headers, url: '/api/mcp', method: 'POST' };
}

function makeRes(): FakeRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    headersSent: false,
    setHeader(k: string, v: unknown) { res.headers[k.toLowerCase()] = v; return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { (res as { body?: unknown }).body = b; return res; },
    end(...args: unknown[]) {
      if (args.length && typeof args[0] === 'string') { (res as { body?: unknown }).body = args[0]; }
      (res as { ended?: boolean }).ended = true;
      return res;
    },
  };
  return res as unknown as FakeRes;
}

// Rows now carry the account-standing columns the pipeline joins in from
// public.users — an active member. Suspension cases live in
// tests/unit/auth/suspendedUserDenied.test.ts.
let membershipRows: Array<{ role: string; account_user_id: string | null; is_active: boolean | null; status: string | null; suspended_at: Date | null }>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SENTRY_ENABLED;
  delete process.env.NEXT_PUBLIC_APP_URL;
  membershipRows = [{ role: 'member', account_user_id: USER_ID, is_active: true, status: 'active', suspended_at: null }];
  h.clientQuery.mockImplementation(async (text: unknown) => {
    if (typeof text === 'string' && text.includes('company_users')) {
      return { rows: membershipRows };
    }
    return { rows: [], command: String(text).trim().split(/\s+/)[0]!.toUpperCase() };
  });
});

const CHALLENGE_RE = /^Bearer realm="IsaFlow MCP", resource_metadata="https:\/\/app\.isaflow\.co\.za\/\.well-known\/oauth-protected-resource"$/;

describe('withBearerAuth — strict Bearer only', () => {
  it('no Authorization header → 401 with the WWW-Authenticate challenge', async () => {
    const handler = vi.fn();
    const res = makeRes();
    await withBearerAuth(handler)(makeReq() as never, res);

    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toMatch(CHALLENGE_RE);
    expect(handler).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('valid session cookie but no Bearer → still 401; cookies are never consulted', async () => {
    const handler = vi.fn();
    const res = makeRes();
    await withBearerAuth(handler)(
      makeReq({ cookie: 'sb-access-token=perfectly-valid-session' }) as never, res,
    );
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toMatch(CHALLENGE_RE);
    expect(withAuth).not.toHaveBeenCalled(); // no cookie fallback path exists
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalid/expired token → 401 + challenge', async () => {
    vi.mocked(validatePat).mockResolvedValue(null);
    const handler = vi.fn();
    const res = makeRes();
    await withBearerAuth(handler)(makeReq({ authorization: `Bearer ${RAW}` }) as never, res);
    expect(res.statusCode).toBe(401);
    expect(res.body?.error?.code).toBe('INVALID_TOKEN');
    expect(String(res.headers['www-authenticate'])).toMatch(CHALLENGE_RE);
  });

  it('unsupported bearer prefix → 401 + challenge', async () => {
    const handler = vi.fn();
    const res = makeRes();
    await withBearerAuth(handler)(makeReq({ authorization: 'Bearer tok_nope' }) as never, res);
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toMatch(CHALLENGE_RE);
  });

  it('valid pat_ → handler runs with scopes attached and GUCs set (shared pipeline)', async () => {
    vi.mocked(validatePat).mockResolvedValue({
      patId: PAT_ID, userId: USER_ID, companyId: COMPANY_ID, scopes: ['read:reports'],
    });
    const handler = vi.fn(async (_req: unknown, res: NextApiResponse) => { res.status(200).json({ ok: true } as never); });
    const req = makeReq({ authorization: `Bearer ${RAW}` });
    const res = makeRes();
    await withBearerAuth(handler)(req as never, res);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(req.companyId).toBe(COMPANY_ID);
    expect(req.scopes).toEqual(['read:reports']);
    expect(req.authMethod).toBe('pat');
    const stmts = h.clientQuery.mock.calls.map((c) => String(c[0]));
    expect(stmts.some((s) => s.includes('request.jwt.claims'))).toBe(true);
    expect(stmts.some((s) => s.includes('app.current_company_id'))).toBe(true);
    expect(stmts).toContain('COMMIT');
    // success responses carry no challenge
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('membership revoked after mint → 403 (no challenge — authenticated but forbidden)', async () => {
    vi.mocked(validatePat).mockResolvedValue({
      patId: PAT_ID, userId: USER_ID, companyId: COMPANY_ID, scopes: ['read:reports'],
    });
    membershipRows = [];
    const handler = vi.fn();
    const res = makeRes();
    await withBearerAuth(handler)(makeReq({ authorization: `Bearer ${RAW}` }) as never, res);
    expect(res.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('challenge origin follows NEXT_PUBLIC_APP_URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3200';
    const res = makeRes();
    await withBearerAuth(vi.fn())(makeReq() as never, res);
    expect(String(res.headers['www-authenticate'])).toContain(
      'resource_metadata="http://localhost:3200/.well-known/oauth-protected-resource"',
    );
  });
});

it('bearer evidence rollback replaces buffered json/end with exactly one safe500', async () => {
  vi.mocked(validatePat).mockResolvedValue({ patId: PAT_ID, userId: USER_ID, companyId: COMPANY_ID, scopes: [] });
  const res = makeRes();
  const flushed: unknown[] = [];
  res.end = ((value: unknown) => { flushed.push(value); return res; }) as typeof res.end;
  res.json = ((value: unknown) => res.end(JSON.stringify(value))) as typeof res.json;
  const { als } = await import('@/lib/als');
  await withBearerAuth(async (_req, response) => {
    als.getStore()!.controlWriteFailed = true;
    response.status(200).json({ success: true, sensitive: 'must not flush' });
  })(makeReq({ authorization: `Bearer ${RAW}` }) as never, res);
  const statements = h.clientQuery.mock.calls.map(call => call[0]);
  expect(statements.filter(statement => statement === 'ROLLBACK')).toHaveLength(1);
  expect(statements).not.toContain('COMMIT');
  expect(flushed).toHaveLength(1);
  expect(String(flushed[0])).not.toContain('must not flush');
  expect(res.statusCode).toBe(500);
  expect(h.client.release).toHaveBeenCalledTimes(1);
});
