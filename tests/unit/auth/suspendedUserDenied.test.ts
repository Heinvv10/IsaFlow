/**
 * A suspended or deactivated user must lose access at the auth layer.
 *
 * Before this guard, adminUserActionsService.suspendUser() flipped
 * users.is_active/suspended_at and deleted the legacy user_sessions rows, but
 * nothing in withAuth, bearerPipeline or withUserAuth ever read those columns —
 * a suspended user holding a live GoTrue cookie kept full access until the
 * token expired.
 *
 * These tests assert on BEHAVIOUR (handler ran? status code? transaction
 * finalised how?), never on SQL text, so an explanatory SQL comment mentioning
 * `is_active` cannot keep them green once the real predicate is removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
const COMPANY_ID = '00000000-0000-0000-0000-000000000cc1';
const USER_ID = '11111111-1111-1111-1111-111111111111';

interface MockClient { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
let currentClient: MockClient;
const poolFactory = { connect: vi.fn(async () => currentClient), on: vi.fn() };

vi.mock('pg', () => {
  class Pool { connect = poolFactory.connect; on = poolFactory.on; }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: vi.fn(() => '10.0.0.1') }));
vi.mock('@/lib/als', () => ({ als: { run: vi.fn((_s: unknown, cb: () => unknown) => cb()) } }));

const logWarn = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() } }));

/** The single row the membership+standing lookup resolves to, or [] for none. */
type MembershipRow = Record<string, unknown>;

function makeClient(rows: MembershipRow[], events: string[]): MockClient {
  return {
    query: vi.fn(async (text: string) => {
      const t = String(text);
      const verb = t.trim().split(/\s+/)[0]!.toUpperCase();
      if (/FROM company_users/i.test(t)) return { rows };
      if (verb === 'BEGIN' || verb === 'COMMIT' || verb === 'ROLLBACK') events.push(verb);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function makeRes() {
  const headers: Record<string, unknown> = {};
  const state = { statusCode: 200, finished: false, body: undefined as unknown };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(c: number) { state.statusCode = c; },
    get headersSent() { return state.finished; },
    status(c: number) { state.statusCode = c; return res; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    json(v: unknown) { state.body = v; return res.send(JSON.stringify(v)); },
    send(v: unknown) { return res.end(v); },
    end(v?: unknown) { if (!state.finished) { state.finished = true; if (v !== undefined && state.body === undefined) state.body = v; } return res; },
  };
  return { res: res as unknown as NextApiResponse, state };
}

/** Reads the error code out of the envelope the pipeline responded with. */
function errorCode(body: unknown): string | undefined {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  return (parsed as { error?: { code?: string } } | null)?.error?.code;
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, email: 'x@y.z', aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

const ACTIVE_ROW: MembershipRow = {
  role: 'admin', account_user_id: USER_ID, is_active: true, status: 'active', suspended_at: null,
};

function mkReq(token: string) {
  return { headers: { cookie: `sb-access-token=${token}; active_company_id=${COMPANY_ID}` }, url: '/api/test' } as never;
}

describe('withAuth — suspended account gate', () => {
  beforeEach(() => {
    vi.resetModules();
    logWarn.mockClear();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.DATABASE_URL = 'postgresql://dummy:dummy@dummy/test';
    process.env.SENTRY_ENABLED = 'false';
  });

  async function run(rows: MembershipRow[]) {
    const events: string[] = [];
    currentClient = makeClient(rows, events);
    const { res, state } = makeRes();
    const { withAuth } = await import('@/lib/auth/withAuth');
    const handler = vi.fn(async (_req: never, r: NextApiResponse) => { r.status(200).json({ ok: true }); });
    const tok = await makeToken(USER_ID);
    await withAuth(handler as never)(mkReq(tok), res);
    return { handler, res, state, events };
  }

  it('lets an active member through', async () => {
    const { handler, res } = await run([ACTIVE_ROW]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  for (const [label, patch] of [
    ['is_active = false', { is_active: false }],
    ['is_active = null', { is_active: null }],
    ['status = suspended', { status: 'suspended' }],
    ['suspended_at set', { suspended_at: new Date('2026-01-01') }],
  ] as Array<[string, Partial<MembershipRow>]>) {
    it(`denies a member whose account has ${label}`, async () => {
      const { handler, res, state, events } = await run([{ ...ACTIVE_ROW, ...patch }]);
      expect(handler).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(errorCode(state.body)).toBe('ACCOUNT_SUSPENDED');
      expect(events).toContain('ROLLBACK');
      expect(events).not.toContain('COMMIT');
      expect(logWarn).toHaveBeenCalled();
    });
  }

  it('denies a membership row with no users profile — and does NOT call it a suspension', async () => {
    // company_users.user_id has NO foreign key to users — a membership can
    // outlive the profile. Fail closed rather than trust the orphan, but report
    // the actual condition: nobody suspended this account, the profile is gone.
    const { handler, res, state } = await run([
      { role: 'admin', account_user_id: null, is_active: null, status: null, suspended_at: null },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(errorCode(state.body)).toBe('ACCOUNT_PROFILE_MISSING');
    expect(errorCode(state.body)).not.toBe('ACCOUNT_SUSPENDED');
  });

  it('still 403s a non-member with the membership reason, not the suspension one', async () => {
    const { handler, res, state } = await run([]);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(errorCode(state.body)).toBe('FORBIDDEN');
  });
});

describe('withUserAuth — suspended account gate', () => {
  const sqlMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    logWarn.mockClear();
    sqlMock.mockReset();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    vi.doMock('@/lib/neon', () => ({ sql: sqlMock }));
  });

  function mkUserRes() { return makeRes(); }
  function mkUserReq(token: string) { return { headers: { cookie: `sb-access-token=${token}` } } as never; }

  async function run(profileRows: MembershipRow[]) {
    sqlMock.mockResolvedValue(profileRows);
    const { res, state } = mkUserRes();
    const { withUserAuth } = await import('@/lib/auth/withUserAuth');
    const handler = vi.fn(async (_req: never, r: NextApiResponse) => { r.status(200).json({ ok: true }); });
    const tok = await makeToken(USER_ID);
    await withUserAuth(handler as never)(mkUserReq(tok), res);
    return { handler, res, state };
  }

  it('lets an active user through', async () => {
    const { handler, res } = await run([{ is_active: true, status: 'active', suspended_at: null }]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('denies a suspended user', async () => {
    const { handler, res, state } = await run([{ is_active: false, status: 'active', suspended_at: new Date() }]);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(errorCode(state.body)).toBe('ACCOUNT_SUSPENDED');
    expect(logWarn).toHaveBeenCalled();
  });

  it('ALLOWS a user with no profile row yet — registration provisions it later', async () => {
    // /api/auth/me and the onboarding wizard legitimately run before
    // tenantProvisioningService INSERTs into public.users. Requiring the row
    // here would make signup impossible.
    const { handler, res } = await run([]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
