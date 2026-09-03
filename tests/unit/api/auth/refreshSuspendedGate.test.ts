/**
 * /api/auth/refresh and /api/auth/2fa-challenge both mint session cookies and
 * neither consulted account standing.
 *
 * refresh is the more consequential of the two: it renews indefinitely, so a
 * suspended user whose GoTrue revocation failed (suspendUser warns about
 * exactly this) would otherwise keep a live session forever. Gating it makes
 * the suspension self-healing on the next refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const refreshFn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/gotrue', () => ({ refresh: (...a: unknown[]) => refreshFn(...a) }));

const setAuthCookies = vi.hoisted(() => vi.fn());
const clearAuthCookies = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: (...a: unknown[]) => setAuthCookies(...a),
  clearAuthCookies: (...a: unknown[]) => clearAuthCookies(...a),
  parseCookies: () => ({ 'sb-refresh-token': 'rt' }),
  REFRESH_COOKIE: 'sb-refresh-token',
  REMEMBER_ME_COOKIE: 'isaflow_remember_me',
}));

const requireActiveAccount = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('@/lib/auth/requireActiveAccount', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccount(...a),
}));

import refreshHandler from '../../../../pages/api/auth/refresh';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

function mkReqRes() {
  const req = { method: 'POST', body: {}, headers: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & { statusCode: number; body: { error?: { code: string } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshFn.mockResolvedValue({
    access_token: 'a', refresh_token: 'r', expires_in: 3600,
    user: { id: 'user-1', email: 'u@example.com' },
  });
  requireActiveAccount.mockResolvedValue(null);
});

describe('POST /api/auth/refresh — suspended account gate', () => {
  it('rotates cookies for an active user', async () => {
    const { req, res } = mkReqRes();
    await (refreshHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(setAuthCookies).toHaveBeenCalled();
  });

  it('SECURITY: refuses to rotate cookies for a suspended user, and clears them', async () => {
    requireActiveAccount.mockResolvedValue({ code: 'ACCOUNT_SUSPENDED', message: 'suspended' });
    const { req, res } = mkReqRes();
    await (refreshHandler as unknown as Handler)(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
    // The whole point: the session must not be renewed, and the stale cookies
    // must go so the browser stops retrying forever.
    expect(setAuthCookies).not.toHaveBeenCalled();
    expect(clearAuthCookies).toHaveBeenCalled();
  });

  it('checks standing for the user the refresh token resolved to', async () => {
    const { req, res } = mkReqRes();
    await (refreshHandler as unknown as Handler)(req, res);
    expect(requireActiveAccount).toHaveBeenCalledWith('user-1');
  });
});
