/**
 * withAuth's print-token branch: the query-string strip.
 *
 * withAuth compares the token's bound paths against `req.url.split('?')[0]`.
 * That strip is the only behaviour the multi-path token depends on that the
 * printAuth unit tests cannot reach, and getting it wrong goes both ways: keep
 * the query and every real print request 401s, strip too much (a path prefix,
 * a trailing slash) and the token widens.
 *
 * pg is mocked so `connect()` rejects with a sentinel. Acceptance is therefore
 * observable as "reached the database", without a database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const CONNECT_SENTINEL = 'withAuth-test: reached the pool';

vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('pg', async (importOriginal) => {
  // Only the Pool is replaced. `pg.types` stays real because withAuth imports
  // src/lib/pgTypes.ts for its side effect (the DATE parser registration).
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  class Pool {
    on(): void {
      /* the real pool registers a background error handler */
    }
    connect(): Promise<never> {
      return Promise.reject(new Error(CONNECT_SENTINEL));
    }
  }
  return { default: { ...actual.default, Pool } };
});

vi.mock('@/lib/auth/gotrue', () => ({
  verifyToken: vi.fn(() => {
    throw new Error('no GoTrue session');
  }),
}));

const { withAuth } = await import('@/lib/auth/withAuth');
const { mintPrintToken } = await import('@/lib/pdf/printAuth');
const { ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } = await import('@/lib/auth/cookies');

const ORIGINAL_SECRET = process.env.PRINT_TOKEN_SECRET;
const ORIGINAL_DB_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-000000000002';
const PACK = '/api/accounting/reports-pack';
const TREND = '/api/accounting/packs/management/trend';

beforeEach(() => {
  process.env.PRINT_TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.DATABASE_URL = 'postgres://unused';
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.PRINT_TOKEN_SECRET;
  else process.env.PRINT_TOKEN_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

interface Captured {
  status: number | null;
  body: unknown;
  setCookies: string[];
}

async function callWithAuth(url: string, token: string, companyId = COMPANY): Promise<Captured> {
  const captured: Captured = { status: null, body: null, setCookies: [] };
  const res = {
    setHeader: (name: string, value: string | string[]) => {
      if (name.toLowerCase() === 'set-cookie') {
        captured.setCookies = Array.isArray(value) ? value : [value];
      }
    },
    getHeader: () => undefined,
    status: (code: number) => {
      captured.status = code;
      return {
        json: (body: unknown) => {
          captured.body = body;
          return undefined;
        },
      };
    },
  } as unknown as NextApiResponse;

  const req = {
    url,
    method: 'GET',
    headers: { cookie: `${ACCESS_COOKIE}=${token}; ${ACTIVE_COMPANY_COOKIE}=${companyId}` },
  } as unknown as NextApiRequest;

  const handler = withAuth(() => {
    throw new Error('withAuth-test: handler must not run');
  });
  await handler(req, res);
  return captured;
}

describe('withAuth — print token, query-string strip', () => {
  it('accepts a token for /api/x on /api/x?print=1 — the query is stripped before comparison', async () => {
    const token = mintPrintToken(COMPANY, USER, [PACK, TREND]);
    // Acceptance runs on to the pool, which the mock rejects. A 401 here would
    // mean the query string was compared as part of the path.
    await expect(callWithAuth(`${PACK}?print=1&from=2026-01-01`, token)).rejects.toThrow(CONNECT_SENTINEL);
    await expect(callWithAuth(`${TREND}?months=12`, token)).rejects.toThrow(CONNECT_SENTINEL);
  });

  it('rejects a trailing-slash variant of the bound path with a plain 401', async () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    const captured = await callWithAuth(`${PACK}/`, token);
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
    });
    // A genuine token bound elsewhere must not wipe the cookies mid-render.
    expect(captured.setCookies).toEqual([]);
  });

  it('rejects a path outside the bound set, and a bound path under the wrong company', async () => {
    const token = mintPrintToken(COMPANY, USER, [PACK, TREND]);
    expect((await callWithAuth('/api/accounting/customers', token)).status).toBe(401);

    const otherCompany = '00000000-0000-0000-0000-0000000000ff';
    expect((await callWithAuth(PACK, token, otherCompany)).status).toBe(401);
  });
});

/**
 * IMPORTANT-2: the bound-path decision used to be an inline
 * `candidate.paths.includes(...)` here, against verifyPrintTokenSignature.
 * `verifyPrintToken` — the function carrying the exact-match and
 * prefix-widening tests — had no production caller, so those tests protected
 * nothing that ran. withAuth now goes through authenticatePrintToken, which
 * calls verifyPrintToken and nothing else; these cases exercise that path
 * end to end through the middleware, not through printAuth directly.
 */
describe('withAuth — the bound-path check runs through verifyPrintToken', () => {
  it('rejects every prefix-widened variant of a bound path', async () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    for (const widened of [`${PACK}-secret`, `${PACK}/sub`, '/api/accounting/reports', `${PACK}/`]) {
      const captured = await callWithAuth(widened, token);
      expect(captured.status, widened).toBe(401);
      // Genuine token, wrong path: the render's own cookies must survive.
      expect(captured.setCookies, widened).toEqual([]);
    }
  });

  it('accepts the exact bound path — the same token, one character shorter', async () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    await expect(callWithAuth(PACK, token)).rejects.toThrow(CONNECT_SENTINEL);
  });

  it('clears cookies for a forged token, but never for a genuine one bound elsewhere', async () => {
    const genuine = mintPrintToken(COMPANY, USER, [PACK]);
    expect((await callWithAuth('/api/accounting/customers', genuine)).setCookies).toEqual([]);

    const [payload] = genuine.split('.');
    const forged = `${payload}.${'0'.repeat(64)}`;
    const captured = await callWithAuth(PACK, forged);
    expect(captured.status).toBe(401);
    expect(captured.setCookies.length).toBeGreaterThan(0);
  });
});
