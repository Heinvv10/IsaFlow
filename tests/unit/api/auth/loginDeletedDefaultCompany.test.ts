/**
 * POST /api/auth/login must not hand the browser a company withAuth refuses.
 *
 * Incident 2026-10-16: a user's DEFAULT company was soft-deleted by an admin
 * (`companies.status = 'deleted'`, `is_active` untouched). Login picked the
 * default membership with a bare `company_users` query, set
 * `active_company_id` to the deleted company, and every company-scoped request
 * afterwards answered 403 'Not a member of this company' — a signed-in session
 * where nothing worked and /home spun forever.
 *
 * Assertions are behavioural: WHICH company id reached the cookie, and whether
 * a cookie was set at all.
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
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const signIn = vi.fn();
vi.mock('@/lib/auth/gotrue', () => ({ signIn: (...a: unknown[]) => signIn(...a) }));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  listFactors: vi.fn(async () => ({ totp: [] as Array<{ id: string; status: string }> })),
  GotrueMfaError: class GotrueMfaError extends Error {},
}));

const setAuthCookies = vi.fn();
const setActiveCompanyCookie = vi.fn();
const setOnboardingDoneCookie = vi.fn();
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: (...a: unknown[]) => setAuthCookies(...a),
  setActiveCompanyCookie: (...a: unknown[]) => setActiveCompanyCookie(...a),
  setOnboardingDoneCookie: (...a: unknown[]) => setOnboardingDoneCookie(...a),
  setPendingMfaCookie: vi.fn(),
  setPendingRememberCookie: vi.fn(),
}));
vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: vi.fn(async () => ({ locked: false })),
  recordFailure: vi.fn(async () => ({ locked: false })),
  clearLockout: vi.fn(),
}));

/**
 * The membership pick is delegated to src/lib/auth/liveCompanies.ts (shared
 * with withAuth's own predicate, and tested against a filter-aware fake in
 * tests/unit/auth/liveCompanies.test.ts). Here it is stubbed so this file
 * asserts only what login DOES with the answer.
 */
let liveCompanyId: string | null = 'live-company';
vi.mock('@/lib/auth/liveCompanies', () => ({
  pickInitialCompanyId: vi.fn(async () => liveCompanyId),
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [{ is_active: true, status: 'active', suspended_at: null }]),
}));

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
  return { req, res: res as unknown as NextApiResponse & { statusCode: number; body: { success: boolean; data?: { activeCompanyId: string | null } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  liveCompanyId = 'live-company';
  signIn.mockResolvedValue({
    access_token: 'a', refresh_token: 'r', expires_in: 3600,
    user: { id: 'user-1', email: 'u@example.com' },
  });
});

describe('POST /api/auth/login — active company at sign-in', () => {
  it('sets the cookie to the live company the shared picker chose, not to a raw default membership', async () => {
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);

    expect(res.statusCode).toBe(200);
    expect(setActiveCompanyCookie).toHaveBeenCalledWith(expect.anything(), 'live-company');
    expect(res.body.data?.activeCompanyId).toBe('live-company');
    expect(setOnboardingDoneCookie).toHaveBeenCalled();
  });

  it('sets NO active-company cookie when the user has no live company left', async () => {
    // The deleted-default user with nothing else: a cookie here would 403 every
    // later call. Better signed in with no company (the client shows the
    // "no company" screen) than signed in and broken.
    liveCompanyId = null;
    const { req, res } = mockReqRes();
    await (loginHandler as unknown as Handler)(req, res);

    expect(res.statusCode).toBe(200);
    expect(setAuthCookies).toHaveBeenCalled();
    expect(setActiveCompanyCookie).not.toHaveBeenCalled();
    expect(setOnboardingDoneCookie).not.toHaveBeenCalled();
    expect(res.body.data?.activeCompanyId).toBeNull();
  });
});
