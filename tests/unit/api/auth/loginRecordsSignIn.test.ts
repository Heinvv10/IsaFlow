/**
 * Audit 2026-11-14 item 1.1: nothing wrote users.last_login. POST /api/auth/login records the sign-in when it
 * issues a session, and only then: not for a wrong password, a suspended account, or while a 2FA code is still owed
 * (2fa-challenge records that one). A recorder failure must never fail the sign-in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  chargeRateLimit: vi.fn(async () => ({ admitted: true, windowStart: null })),
  refundRateLimit: vi.fn(async () => undefined),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const signIn = vi.fn();
vi.mock('@/lib/auth/gotrue', () => ({ signIn: (...a: unknown[]) => signIn(...a) }));
const listFactors = vi.fn(async () => ({ totp: [] as Array<{ id: string; status: string }> }));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  listFactors: (...a: unknown[]) => listFactors(...a),
  GotrueMfaError: class GotrueMfaError extends Error {},
}));
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: vi.fn(), setActiveCompanyCookie: vi.fn(), setOnboardingDoneCookie: vi.fn(),
  setPendingMfaCookie: vi.fn(), setPendingRememberCookie: vi.fn(),
}));
vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: vi.fn(async () => ({ locked: false })),
  recordFailure: vi.fn(async () => ({ locked: false })),
  clearLockout: vi.fn(),
}));
let accountRows: Array<Record<string, unknown>>;
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) =>
    (/FROM users/i.test(strings.join('?')) ? accountRows : [{ company_id: 'company-1', is_default: true, created_at: new Date() }])),
}));
const recordSignInSafely = vi.fn(async (): Promise<void> => undefined);
vi.mock('@/lib/auth/recordSignIn', () => ({ recordSignInSafely: (...a: unknown[]) => recordSignInSafely(...(a as [])) }));

import loginHandler from '../../../../pages/api/auth/login';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;
function mockReqRes() {
  const req = { method: 'POST', body: { email: 'u@example.com', password: 'pw' }, headers: {} } as unknown as NextApiRequest;
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
  accountRows = [{ is_active: true, status: 'active', suspended_at: null }];
  signIn.mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'user-1', email: 'u@example.com' } });
  listFactors.mockResolvedValue({ totp: [] });
});

describe('POST /api/auth/login records the sign-in', () => {
  it('a session is issued: the user id is recorded once', async () => {
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(recordSignInSafely).toHaveBeenCalledTimes(1);
    expect(recordSignInSafely).toHaveBeenCalledWith('user-1', 'login');
  });

  it('the response does not wait for the stamp: a hung stamp cannot hold the sign-in, and is still attempted once', async () => {
    recordSignInSafely.mockReturnValueOnce(new Promise(() => undefined));
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(recordSignInSafely).toHaveBeenCalledTimes(1);
  });

  it('a wrong password records nothing', async () => {
    signIn.mockRejectedValueOnce(new Error('invalid credentials'));
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(401);
    expect(recordSignInSafely).not.toHaveBeenCalled();
  });

  it('a suspended account records nothing', async () => {
    accountRows = [{ is_active: false, status: 'active', suspended_at: null }];
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(403);
    expect(recordSignInSafely).not.toHaveBeenCalled();
  });

  it('a 2FA code still owed records nothing (the challenge records it)', async () => {
    listFactors.mockResolvedValue({ totp: [{ id: 'f-1', status: 'verified' }] });
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(recordSignInSafely).not.toHaveBeenCalled();
  });
});
