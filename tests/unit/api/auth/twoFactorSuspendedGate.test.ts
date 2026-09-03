/**
 * /api/auth/2fa-challenge mints full session cookies once an MFA code checks
 * out. login now denies a suspended user before the MFA branch, but a user
 * suspended DURING the challenge window would otherwise still be handed a
 * session. Closes that window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
// Set BEFORE the handler import — @/lib/auth/gotrue reads the secret eagerly.
process.env.JWT_SECRET = TEST_SECRET;
process.env.GOTRUE_URL = 'http://example.test/auth/v1';

// Holder the hoisted cookies mock reads, so the route sees a real signed JWT.
const cookieJar = vi.hoisted(() => ({ pending: '' }));

vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const challengeFactor = vi.hoisted(() => vi.fn(async () => 'challenge-1'));
const verifyFactor = vi.hoisted(() => vi.fn(async () => ({
  access_token: 'a2', refresh_token: 'r2', expires_in: 3600,
})));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  challengeFactor: (...a: unknown[]) => challengeFactor(...a),
  verifyFactor: (...a: unknown[]) => verifyFactor(...a),
  GotrueMfaError: class GotrueMfaError extends Error {},
}));

const setAuthCookies = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: (...a: unknown[]) => setAuthCookies(...a),
  setActiveCompanyCookie: vi.fn(),
  clearPendingMfaCookie: vi.fn(),
  clearPendingRememberCookie: vi.fn(),
  clearAuthCookies: vi.fn(),
  parseCookies: () => ({ 'sb-pending-mfa': cookieJar.pending }),
  PENDING_MFA_COOKIE: 'sb-pending-mfa',
  PENDING_REMEMBER_COOKIE: 'sb-pending-remember',
}));

vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: vi.fn(async () => ({ locked: false })),
  recordFailure: vi.fn(async () => ({ locked: false })),
  clearLockout: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

const requireActiveAccount = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('@/lib/auth/requireActiveAccount', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccount(...a),
}));

import challengeHandler from '../../../../pages/api/auth/2fa-challenge';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

async function pendingToken() {
  return new SignJWT({ sub: 'user-1', email: 'u@example.com', aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkReqRes(pending: string) {
  cookieJar.pending = pending;
  const req = {
    method: 'POST',
    body: { factor_id: 'factor-1', code: '123456', pending_token: pending },
    headers: { cookie: `sb-pending-mfa=${pending}` },
  } as unknown as NextApiRequest;
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
  requireActiveAccount.mockResolvedValue(null);
  verifyFactor.mockResolvedValue({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
});

describe('POST /api/auth/2fa-challenge — suspended account gate', () => {
  it('issues a session for an active user with a valid code', async () => {
    const { req, res } = mkReqRes(await pendingToken());
    await (challengeHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(setAuthCookies).toHaveBeenCalled();
  });

  it('SECURITY: a user suspended during the challenge window gets no session', async () => {
    requireActiveAccount.mockResolvedValue({ code: 'ACCOUNT_SUSPENDED', message: 'suspended' });
    const { req, res } = mkReqRes(await pendingToken());
    await (challengeHandler as unknown as Handler)(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
    expect(setAuthCookies).not.toHaveBeenCalled();
  });
});
