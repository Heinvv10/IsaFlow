/**
 * Dual-auth wrapper — error-path and rate-limit edges (MCP Phase 0, Task 0.5
 * review fixes). Complements withBearerOrCookieAuth.test.ts (300-line cap).
 *
 * Branches under test (src/lib/auth/withBearerOrCookieAuth.ts):
 *  - AUTO_RATE_LIMIT mirror: reports-* route + exhausted bucket → 429 + ROLLBACK
 *  - membership query 22P02 (invalid uuid cast — forged/stale PAT) → 403
 *  - membership query real DB error → propagates (500 path), ROLLBACK + release
 *  - handler throw → ROLLBACK (never COMMIT) + release, error propagates
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

const h = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const client = { query: clientQuery, release: vi.fn() };
  const connect = vi.fn(async () => client);
  return { client, clientQuery, connect };
});

vi.mock('pg', () => ({
  default: {
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

import { checkRateLimit } from '@/lib/rateLimit';
import { validatePat } from '@/lib/auth/personalAccessTokens';
import { withBearerOrCookieAuth } from '@/lib/auth/withBearerOrCookieAuth';

const USER_ID = 'user-gotrue-1';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const PAT_ID = '33333333-3333-3333-3333-333333333333';
const RAW = `pat_${'A'.repeat(32)}`;

process.env.DATABASE_URL ||= 'postgres://unit-test-not-used';

interface FakeRes extends NextApiResponse {
  statusCode: number;
  body?: { success: boolean; error?: { code: string; message: string } };
  headers: Record<string, unknown>;
}

function makeReq(url: string): Record<string, unknown> {
  return { headers: { authorization: `Bearer ${RAW}` }, url, method: 'GET' };
}

function makeRes(): FakeRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    setHeader(k: string, v: unknown) { res.headers[k] = v; return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { (res as { body?: unknown }).body = b; return res; },
  };
  return res as unknown as FakeRes;
}

let membershipImpl: () => Promise<{ rows: Array<{ role: string }> }>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SENTRY_ENABLED;
  vi.mocked(validatePat).mockResolvedValue({
    patId: PAT_ID, userId: USER_ID, companyId: COMPANY_ID, scopes: ['read:reports'],
  });
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  membershipImpl = async () => ({ rows: [{ role: 'member' }] });
  h.clientQuery.mockImplementation(async (text: unknown) => {
    if (typeof text === 'string' && text.includes('company_users')) return membershipImpl();
    return { rows: [] };
  });
});

function issuedStatements(): string[] {
  return h.clientQuery.mock.calls.map((c) => String(c[0]));
}

describe('AUTO_RATE_LIMIT mirror', () => {
  it('reports-* route with exhausted bucket → 429 + ROLLBACK, handler never runs', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    const handler = vi.fn();
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(
      makeReq('/api/accounting/reports-trial-balance?asAt=2026-07-18') as never, res,
    );

    expect(checkRateLimit).toHaveBeenCalledWith(
      `reports:${COMPANY_ID}`,
      { max: 60, windowSecs: 60 },
    );
    expect(res.statusCode).toBe(429);
    expect(res.body?.error?.code).toBe('RATE_LIMITED');
    expect(handler).not.toHaveBeenCalled();
    expect(issuedStatements()).toContain('ROLLBACK');
    expect(issuedStatements()).not.toContain('COMMIT');
  });

  it('non-reports route skips the limiter entirely', async () => {
    const handler = vi.fn(async (_req: unknown, res: FakeRes) => { res.status(200).json({ ok: true } as never); });
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(makeReq('/api/mcp') as never, res);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('membership query error classification', () => {
  it('22P02 uuid-cast error (forged/stale PAT) → 403 FORBIDDEN, not a 500', async () => {
    membershipImpl = async () => {
      throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
    };
    const handler = vi.fn();
    const res = makeRes();
    await withBearerOrCookieAuth(handler)(makeReq('/api/mcp') as never, res);

    expect(res.statusCode).toBe(403);
    expect(res.body?.error?.code).toBe('FORBIDDEN');
    expect(handler).not.toHaveBeenCalled();
    expect(issuedStatements()).toContain('ROLLBACK');
  });

  it('real DB error (timeout etc.) propagates as a 500-path rethrow, with ROLLBACK + release', async () => {
    membershipImpl = async () => { throw new Error('connection timeout'); };
    const handler = vi.fn();
    const res = makeRes();
    await expect(
      withBearerOrCookieAuth(handler)(makeReq('/api/mcp') as never, res),
    ).rejects.toThrow('connection timeout');

    expect(handler).not.toHaveBeenCalled();
    expect(issuedStatements()).toContain('ROLLBACK');
    expect(issuedStatements()).not.toContain('COMMIT');
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });
});

describe('handler failure', () => {
  it('handler throw → ROLLBACK (never COMMIT), client released, error propagates', async () => {
    const handler = vi.fn(async () => { throw new Error('handler exploded'); });
    const res = makeRes();
    await expect(
      withBearerOrCookieAuth(handler)(makeReq('/api/mcp') as never, res),
    ).rejects.toThrow('handler exploded');

    expect(issuedStatements()).toContain('ROLLBACK');
    expect(issuedStatements()).not.toContain('COMMIT');
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });
});
