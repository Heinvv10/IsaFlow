/**
 * POST /api/auth/login must refuse a suspended account.
 *
 * Suspension was previously advisory at the login door: signIn() succeeded,
 * cookies were set, and the user only discovered the account was closed when
 * every subsequent API call 403'd. An operator who clicks Suspend reasonably
 * believes the account is closed — "can log in, but nothing works" is a
 * half-state that surfaces during an incident.
 *
 * Assertions are behavioural (were cookies issued? which status? was the
 * standing looked up before the MFA branch?) rather than SQL-text matches, so
 * an explanatory comment naming is_active cannot keep them green.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
// vi.hoisted so the spy exists before the hoisted vi.mock factory runs.
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: logWarn, error: vi.fn() } }));

const signIn = vi.fn();
vi.mock('@/lib/auth/gotrue', () => ({ signIn: (...a: unknown[]) => signIn(...a) }));

const listFactors = vi.fn(async () => ({ totp: [] as Array<{ id: string; status: string }> }));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  listFactors: (...a: unknown[]) => listFactors(...a),
  // Declared inside the factory: vi.mock is hoisted, so a top-level class
  // would be referenced before initialisation.
  GotrueMfaError: class GotrueMfaError extends Error {},
}));

const setAuthCookies = vi.fn();
const setActiveCompanyCookie = vi.fn();
const setPendingMfaCookie = vi.fn();
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: (...a: unknown[]) => setAuthCookies(...a),
  setActiveCompanyCookie: (...a: unknown[]) => setActiveCompanyCookie(...a),
  setOnboardingDoneCookie: vi.fn(),
  setPendingMfaCookie: (...a: unknown[]) => setPendingMfaCookie(...a),
  setPendingRememberCookie: vi.fn(),
}));

vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: vi.fn(async () => ({ locked: false })),
  recordFailure: vi.fn(async () => ({ locked: false })),
  clearLockout: vi.fn(),
}));

/**
 * One `sql` mock serving two different queries. Keyed on the table so the test
 * does not depend on the exact column list — only on which table was asked.
 */
let accountRows: Array<Record<string, unknown>>;
const sqlMock = vi.fn(async (strings: TemplateStringsArray) => {
  const text = strings.join('?');
  if (/FROM users/i.test(text)) return accountRows;
  return [{ company_id: 'company-1', is_default: true, created_at: new Date() }];
});
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...(a as [TemplateStringsArray])) }));

import loginHandler from '../../../../pages/api/auth/login';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

function mockReqRes() {
  const req = { method: 'POST', body: { email: 'u@example.com', password: 'pw' }, headers: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & { statusCode: number; body: { success: boolean; error?: { code: string } } } };
}

const ACTIVE = { is_active: true, status: 'active', suspended_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  accountRows = [ACTIVE];
  signIn.mockResolvedValue({
    access_token: 'a', refresh_token: 'r', expires_in: 3600,
    user: { id: 'user-1', email: 'u@example.com' },
  });
  listFactors.mockResolvedValue({ totp: [] });
});

describe('POST /api/auth/login — suspended account gate', () => {
  it('lets an active user sign in', async () => {
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(setAuthCookies).toHaveBeenCalled();
  });

  for (const [label, patch] of [
    ['is_active = false', { is_active: false }],
    ['status = suspended', { status: 'suspended' }],
    ['suspended_at set', { suspended_at: new Date('2026-01-01') }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`SECURITY: refuses a correct password when ${label} — no cookies issued`, async () => {
      accountRows = [{ ...ACTIVE, ...patch }];
      const { req, res } = mockReqRes();
      await (loginHandler as unknown as Handler)(req, res);

      expect(res.statusCode).toBe(403);
      expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
      // The whole point: no session is minted for a closed account.
      expect(setAuthCookies).not.toHaveBeenCalled();
      expect(setActiveCompanyCookie).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });
  }

  it('SECURITY: denies BEFORE the MFA branch — a suspended user never gets a 2FA challenge', async () => {
    // An enrolled suspended user must be stopped at the password stage, not
    // walked through a challenge for an account that is closed anyway.
    accountRows = [{ ...ACTIVE, is_active: false }];
    listFactors.mockResolvedValue({ totp: [{ id: 'factor-1', status: 'verified' }] });
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);

    expect(res.statusCode).toBe(403);
    expect(setPendingMfaCookie).not.toHaveBeenCalled();
  });

  it('allows a user with no profile row yet — signup provisions it after GoTrue', async () => {
    accountRows = [];
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('still rejects a wrong password as invalid credentials, not as suspension', async () => {
    signIn.mockRejectedValueOnce(new Error('invalid credentials'));
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error?.code).toBe('INVALID_CREDENTIALS');
  });
});
