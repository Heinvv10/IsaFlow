/**
 * Audit 2026-11-14 item 1.1: a sign-in that needed a 2FA code is recorded when the code checks out, never earlier
 * (login withholds the session) and never when the code is wrong or the account was suspended meanwhile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const cookieJar = vi.hoisted(() => ({ pending: '' }));

vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  chargeRateLimit: vi.fn(async () => ({ admitted: true, windowStart: null })),
  refundRateLimit: vi.fn(async () => undefined),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/auth/gotrue', () => ({ verifyTokenSignature: vi.fn(async () => ({ sub: 'user-1', email: 'u@example.com' })) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const verifyFactor = vi.hoisted(() => vi.fn(async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })));
const MfaError = vi.hoisted(() => class MfaError extends Error { status = 422; });
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  challengeFactor: vi.fn(async () => 'challenge-1'),
  verifyFactor: (...a: unknown[]) => verifyFactor(...(a as [])),
  GotrueMfaError: MfaError,
}));
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: vi.fn(), setActiveCompanyCookie: vi.fn(), clearPendingMfaCookie: vi.fn(), clearPendingRememberCookie: vi.fn(),
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
vi.mock('@/lib/auth/requireActiveAccount', () => ({ requireActiveAccount: (...a: unknown[]) => requireActiveAccount(...(a as [])) }));
const recordSignInSafely = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));
vi.mock('@/lib/auth/recordSignIn', () => ({ recordSignInSafely: (...a: unknown[]) => recordSignInSafely(...(a as [])) }));

import challengeHandler from '../../../../pages/api/auth/2fa-challenge';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;
async function mkReqRes() {
  const pending = 'pending-token';
  cookieJar.pending = pending;
  const req = { method: 'POST', body: { factor_id: 'factor-1', code: '123456' }, headers: { cookie: `sb-pending-mfa=${pending}` } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & { statusCode: number } };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireActiveAccount.mockResolvedValue(null);
  verifyFactor.mockResolvedValue({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
});

describe('POST /api/auth/2fa-challenge records the sign-in', () => {
  it('a valid code issues the session and records the user id once', async () => {
    const { req, res } = await mkReqRes();
    await (challengeHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(recordSignInSafely).toHaveBeenCalledTimes(1);
    expect(recordSignInSafely).toHaveBeenCalledWith('user-1', '2fa-challenge');
  });

  it('the response does not wait for the stamp: a hung stamp cannot hold the sign-in, and is still attempted once', async () => {
    recordSignInSafely.mockReturnValueOnce(new Promise(() => undefined));
    const { req, res } = await mkReqRes();
    await (challengeHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(recordSignInSafely).toHaveBeenCalledTimes(1);
  });

  it('a wrong code records nothing', async () => {
    verifyFactor.mockRejectedValueOnce(new MfaError('invalid'));
    const { req, res } = await mkReqRes();
    await (challengeHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(400);
    expect(recordSignInSafely).not.toHaveBeenCalled();
  });

  it('an account suspended during the challenge records nothing', async () => {
    requireActiveAccount.mockResolvedValue({ code: 'ACCOUNT_SUSPENDED', message: 'suspended' });
    const { req, res } = await mkReqRes();
    await (challengeHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(403);
    expect(recordSignInSafely).not.toHaveBeenCalled();
  });
});
