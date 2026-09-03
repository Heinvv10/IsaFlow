/**
 * Every remaining path that establishes identity must consult account standing.
 *
 * A census of `verifyToken(` callers found seven identity-establishing points.
 * Four were already gated (withAuth, withUserAuth, bearerPipeline, login).
 * These are the rest:
 *   - withPlatformAdmin  — the BYPASSRLS admin console, highest privilege
 *   - /api/auth/refresh  — renews session cookies indefinitely
 *   - /api/auth/2fa-challenge — mints session cookies after an MFA code
 *
 * Behavioural assertions only (was a session issued? was the handler run?),
 * never SQL-text matching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
const USER_ID = '11111111-1111-1111-1111-111111111111';

async function makeToken(sub: string) {
  return new SignJWT({ sub, email: 'x@y.z', aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkRes() {
  const headers: Record<string, unknown> = {};
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(c: number) { state.statusCode = c; },
    status(c: number) { state.statusCode = c; return res; },
    json(v: unknown) { state.body = v; return res; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    end() { return res; },
  };
  return { res: res as unknown as NextApiResponse, state };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

const ACTIVE = { is_active: true, status: 'active', suspended_at: null };
const SUSPENDED = { is_active: false, status: 'active', suspended_at: new Date('2026-01-01') };

// ─────────────────────────── withPlatformAdmin ────────────────────────────
describe('withPlatformAdmin — suspended account gate', () => {
  const appQuery = vi.hoisted(() => vi.fn());
  const adminQuery = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));

  vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
    getAppPool: () => ({ connect: async () => ({ query: appQuery, release: vi.fn() }) }),
    getPlatformAdminPool: () => ({ connect: async () => ({ query: adminQuery, release: vi.fn() }) }),
  }));
  vi.mock('@/lib/als', () => ({ als: { run: vi.fn((_s: unknown, cb: () => unknown) => cb()) } }));
  vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

  /** Drives the gate query to return one row shaped like the users lookup. */
  function setAdminRow(row: Record<string, unknown> | null) {
    appQuery.mockImplementation(async (text: string) => {
      if (/FROM users/i.test(String(text))) return { rows: row ? [row] : [] };
      return { rows: [] };
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.SENTRY_ENABLED = 'false';
    adminQuery.mockImplementation(async () => ({ rows: [] }));
  });

  async function run(row: Record<string, unknown> | null) {
    setAdminRow(row);
    const { res, state } = mkRes();
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const handler = vi.fn(async (_r: never, r: NextApiResponse) => { r.status(200).json({ ok: true }); });
    const tok = await makeToken(USER_ID);
    const req = { headers: { cookie: `sb-access-token=${tok}` }, url: '/api/admin/x' } as never;
    await withPlatformAdmin(handler as never)(req, res);
    return { handler, state };
  }

  it('lets an active super_admin through', async () => {
    const { handler, state } = await run({ role: 'super_admin', ...ACTIVE });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(state.statusCode).toBe(200);
  });

  it('SECURITY: denies a SUSPENDED super_admin — BYPASSRLS is never engaged', async () => {
    const { handler, state } = await run({ role: 'super_admin', ...SUSPENDED });
    expect(handler).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(403);
    expect(errorCode(state.body)).toBe('ACCOUNT_SUSPENDED');
    // The privileged pool must never have opened a transaction.
    expect(adminQuery).not.toHaveBeenCalled();
  });

  it('denies a suspended super_admin by status alone', async () => {
    const { state } = await run({ role: 'super_admin', is_active: true, status: 'suspended', suspended_at: null });
    expect(state.statusCode).toBe(403);
    expect(errorCode(state.body)).toBe('ACCOUNT_SUSPENDED');
  });

  it('a non-admin still gets NOT_SUPER_ADMIN, not a suspension message', async () => {
    const { state } = await run({ role: 'viewer', ...ACTIVE });
    expect(state.statusCode).toBe(403);
    expect(errorCode(state.body)).toBe('NOT_SUPER_ADMIN');
  });

  it('a missing profile row still gets NOT_SUPER_ADMIN — unchanged, cannot lock an admin out', async () => {
    // Pre-existing behaviour: no row => role undefined => not super_admin.
    // The standing gate must not convert this into a different refusal.
    const { state } = await run(null);
    expect(state.statusCode).toBe(403);
    expect(errorCode(state.body)).toBe('NOT_SUPER_ADMIN');
  });
});

// ───────────────────────── requireActiveAccount helper ─────────────────────
describe('requireActiveAccount — shared sql-based guard', () => {
  const sqlMock = vi.hoisted(() => vi.fn());
  vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...(a as [TemplateStringsArray])) }));

  beforeEach(() => { vi.resetModules(); sqlMock.mockReset(); });

  it('returns null (allow) for an active account', async () => {
    sqlMock.mockResolvedValue([ACTIVE]);
    const { requireActiveAccount } = await import('@/lib/auth/requireActiveAccount');
    expect(await requireActiveAccount(USER_ID)).toBeNull();
  });

  it('returns null (allow) when no profile row exists yet', async () => {
    sqlMock.mockResolvedValue([]);
    const { requireActiveAccount } = await import('@/lib/auth/requireActiveAccount');
    expect(await requireActiveAccount(USER_ID)).toBeNull();
  });

  it('returns the suspension refusal for a suspended account', async () => {
    sqlMock.mockResolvedValue([SUSPENDED]);
    const { requireActiveAccount } = await import('@/lib/auth/requireActiveAccount');
    expect(await requireActiveAccount(USER_ID)).toEqual({ code: 'ACCOUNT_SUSPENDED', message: expect.any(String) });
  });
});
