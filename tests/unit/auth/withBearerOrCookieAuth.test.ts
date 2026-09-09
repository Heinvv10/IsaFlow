/**
 * Dual-auth wrapper coverage — PRD-10 (MCP Phase 0, Task 0.3).
 *
 * Security invariants under test:
 *  - Bearer pat_/oat_ requests get the full withAuth-equivalent context:
 *    req.user/companyId/scopes attached, app_user role + GUCs set
 *    (request.jwt.claims, app.current_company_id) BEFORE the handler runs
 *  - an invalid/expired Bearer token → 401 with NO cookie fallback attempt
 *  - membership revoked after mint → 403 (company_users re-check) + ROLLBACK
 *  - no Authorization header → delegates to the cookie withAuth path untouched
 *  - Bearer with an unsupported token prefix → 401, never cookie fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiResponse } from 'next';

const h = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const client = { query: clientQuery, release: vi.fn() };
  const connect = vi.fn(async () => client);
  const cookieHandler = vi.fn(async (_req: unknown, res: { status(c: number): { json(b: unknown): unknown } }) => {
    res.status(299).json({ via: 'cookie' });
  });
  return { client, clientQuery, connect, cookieHandler };
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
  withAuth: vi.fn(() => h.cookieHandler),
}));

vi.mock('@/lib/auth/personalAccessTokens', () => ({
  validatePat: vi.fn(),
}));

vi.mock('@/lib/auth/oauth', () => ({
  validateOauthAccessToken: vi.fn(),
}));

vi.mock('@/lib/als', () => ({
  als: { run: vi.fn((_store: unknown, cb: () => unknown) => cb()) },
}));

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

import { als } from '@/lib/als';
import { withAuth } from '@/lib/auth/withAuth';
import { validatePat } from '@/lib/auth/personalAccessTokens';
import { validateOauthAccessToken } from '@/lib/auth/oauth';
import { withBearerOrCookieAuth } from '@/lib/auth/withBearerOrCookieAuth';

const USER_ID = 'user-gotrue-1';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const PAT_ID = '33333333-3333-3333-3333-333333333333';
const AUTH_ID = '55555555-5555-5555-5555-555555555555';
const APP_ID = '44444444-4444-4444-4444-444444444444';

process.env.DATABASE_URL ||= 'postgres://unit-test-not-used';

interface FakeRes extends NextApiResponse {
  statusCode: number;
  body?: unknown;
  headers: Record<string, unknown>;
}

function makeReq(headers: Record<string, string> = {}, url = '/api/mcp'): Record<string, unknown> {
  return { headers, url, method: 'POST' };
}

function makeRes(): FakeRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    headersSent: false,
    setHeader(k: string, v: unknown) { res.headers[k] = v; return res; },
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

// Rows now carry the account-standing columns joined in from public.users.
let membershipRows: Array<{ role: string; account_user_id: string | null; is_active: boolean | null; status: string | null; suspended_at: Date | null }>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SENTRY_ENABLED;
  membershipRows = [{ role: 'member', account_user_id: USER_ID, is_active: true, status: 'active', suspended_at: null }];
  h.clientQuery.mockImplementation(async (text: unknown) => {
    if (typeof text === 'string' && text.includes('company_users')) {
      return { rows: membershipRows };
    }
    return { rows: [], command: String(text).trim().split(/\s+/)[0]!.toUpperCase() };
  });
});

function issuedStatements(): string[] {
  return h.clientQuery.mock.calls.map((c) => String(c[0]));
}

describe('withBearerOrCookieAuth — Bearer pat_', () => {
  const RAW = `pat_${'A'.repeat(32)}`;

  function validPat(): void {
    vi.mocked(validatePat).mockResolvedValue({
      patId: PAT_ID, userId: USER_ID, companyId: COMPANY_ID, scopes: ['read:reports'],
    });
  }

  it('valid pat_ → handler runs with user/company/scopes attached and GUCs set first', async () => {
    validPat();
    let guardsAtHandlerTime: string[] = [];
    const handler = vi.fn(async (req: Record<string, unknown>, res: FakeRes) => {
      guardsAtHandlerTime = issuedStatements();
      res.status(200).json({ ok: true, companyId: req.companyId });
    });

    const req = makeReq({ authorization: `Bearer ${RAW}` });
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(req as never, res);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(req.companyId).toBe(COMPANY_ID);
    expect(req.scopes).toEqual(['read:reports']);
    expect(req.authMethod).toBe('pat');
    expect(req.patId).toBe(PAT_ID);
    expect((req.user as { id: string }).id).toBe(USER_ID);

    // RLS context established BEFORE the handler ran
    expect(guardsAtHandlerTime.some((s) => s.includes('SET LOCAL ROLE app_user'))).toBe(true);
    expect(guardsAtHandlerTime.some((s) => s.includes('request.jwt.claims'))).toBe(true);
    expect(guardsAtHandlerTime.some((s) => s.includes('app.current_company_id'))).toBe(true);

    // claims payload carries sub + company_id (what RLS policies read)
    const claimsCall = h.clientQuery.mock.calls.find((c) => String(c[0]).includes('request.jwt.claims'));
    const claims = JSON.parse((claimsCall![1] as string[])[0]!) as Record<string, unknown>;
    expect(claims.sub).toBe(USER_ID);
    expect(claims.company_id).toBe(COMPANY_ID);
    const gucCall = h.clientQuery.mock.calls.find((c) => String(c[0]).includes('app.current_company_id'));
    expect(gucCall![1]).toEqual([COMPANY_ID]);

    expect(issuedStatements()).toContain('COMMIT');
    expect(res.headers['Vary']).toBe('Authorization');

    // handler ran inside the ALS transaction scope with the request identity
    const store = vi.mocked(als.run).mock.calls[0]![0] as Record<string, unknown>;
    expect(store.companyId).toBe(COMPANY_ID);
    expect(store.userId).toBe(USER_ID);
    expect(store.client).toBe(h.client);
  });

  it('invalid/expired pat_ → 401 with NO cookie fallback attempted', async () => {
    vi.mocked(validatePat).mockResolvedValue(null);
    const handler = vi.fn();
    const req = makeReq({ authorization: `Bearer ${RAW}` });
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(req as never, res);

    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_TOKEN');
    expect(handler).not.toHaveBeenCalled();
    expect(withAuth).not.toHaveBeenCalled();
    expect(h.cookieHandler).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled(); // never reached the DB
  });

  it('membership revoked after mint → 403 + ROLLBACK (company_users re-check)', async () => {
    validPat();
    membershipRows = []; // access revoked since the PAT was minted
    const handler = vi.fn();
    const req = makeReq({ authorization: `Bearer ${RAW}` });
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(req as never, res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(handler).not.toHaveBeenCalled();
    expect(issuedStatements()).toContain('ROLLBACK');
    expect(issuedStatements()).not.toContain('COMMIT');
  });
});

describe('withBearerOrCookieAuth — Bearer oat_', () => {
  const RAW = `oat_${'B'.repeat(32)}`;

  it('valid oat_ → handler runs with oauth context and the same GUC setup', async () => {
    vi.mocked(validateOauthAccessToken).mockResolvedValue({
      authorisationId: AUTH_ID, oauthAppId: APP_ID,
      userId: USER_ID, companyId: COMPANY_ID, scopes: ['read:invoices', 'offline_access'],
    });
    const handler = vi.fn(async (_req: unknown, res: FakeRes) => { res.status(200).json({ ok: true }); });
    const req = makeReq({ authorization: `Bearer ${RAW}` });
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(req as never, res);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(validatePat)).not.toHaveBeenCalled();
    expect(req.authMethod).toBe('oauth');
    expect(req.oauthAuthorisationId).toBe(AUTH_ID);
    expect(req.oauthAppId).toBe(APP_ID);
    expect(req.scopes).toEqual(['read:invoices', 'offline_access']);
    const stmts = issuedStatements();
    expect(stmts.some((s) => s.includes('request.jwt.claims'))).toBe(true);
    expect(stmts.some((s) => s.includes('app.current_company_id'))).toBe(true);
    expect(stmts).toContain('COMMIT');
  });

  it('invalid/expired oat_ → 401 without cookie fallback', async () => {
    vi.mocked(validateOauthAccessToken).mockResolvedValue(null);
    const handler = vi.fn();
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(makeReq({ authorization: `Bearer ${RAW}` }) as never, res);
    expect(res.statusCode).toBe(401);
    expect(withAuth).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('withBearerOrCookieAuth — dispatch edges', () => {
  it('no Authorization header → falls back to the cookie withAuth path', async () => {
    const handler = vi.fn();
    const req = makeReq({});
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(req as never, res);

    expect(withAuth).toHaveBeenCalledWith(handler);
    expect(h.cookieHandler).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(299); // our stub cookie path responded
    expect(vi.mocked(validatePat)).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('non-Bearer scheme (Basic) → treated as cookie request, not a Bearer 401', async () => {
    const handler = vi.fn();
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(makeReq({ authorization: 'Basic dXNlcjpwdw==' }) as never, res);
    expect(withAuth).toHaveBeenCalled();
    expect(res.statusCode).toBe(299);
  });

  it('Bearer with unsupported token prefix → 401, never cookie fallback', async () => {
    const handler = vi.fn();
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(makeReq({ authorization: 'Bearer tok_unknownformat' }) as never, res);

    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_TOKEN');
    expect(withAuth).not.toHaveBeenCalled();
    expect(vi.mocked(validatePat)).not.toHaveBeenCalled();
    expect(vi.mocked(validateOauthAccessToken)).not.toHaveBeenCalled();
  });
});
