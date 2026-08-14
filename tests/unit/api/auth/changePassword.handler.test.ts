/**
 * Unit tests for POST /api/auth/change-password.
 *
 * Security focus: after a successful self-service password change the handler
 * MUST revoke every OTHER GoTrue session (a stolen refresh token can otherwise
 * be replayed through /api/auth/refresh forever) and re-issue the caller's
 * cookies from the surviving session. Mutation check: delete the
 * rotateSessionRevokingOthers call in the handler and the first test goes red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// withUserAuth injects the authenticated user; withCsrf is a pass-through.
vi.mock('@/lib/auth/withUserAuth', () => ({
  withUserAuth:
    (h: (req: NextApiRequest, res: NextApiResponse) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) => {
      (req as unknown as { user: unknown }).user = { id: 'user-1', email: 'user@example.com', claims: {} };
      return h(req, res);
    },
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

const signIn = vi.fn(async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
const adminUpdateUser = vi.fn(async () => ({ id: 'user-1', email: 'user@example.com' }));
vi.mock('@/lib/auth/gotrue', () => ({
  signIn: (...a: unknown[]) => signIn(...a),
  adminUpdateUser: (...a: unknown[]) => adminUpdateUser(...a),
}));

const rotateSessionRevokingOthers = vi.fn(async () => ({
  access_token: 'fresh-access',
  refresh_token: 'fresh-refresh',
  expires_in: 3600,
}));
vi.mock('@/lib/auth/sessionRevocation', () => ({
  rotateSessionRevokingOthers: (...a: unknown[]) => rotateSessionRevokingOthers(...a),
  revokeAllSessions: vi.fn(),
}));

const setAuthCookies = vi.fn();
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: (...a: unknown[]) => setAuthCookies(...a),
  parseCookies: () => ({}),
  REMEMBER_ME_COOKIE: 'isaflow_remember_me',
}));

import changePasswordHandler from '../../../../pages/api/auth/change-password';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

function mockReqRes(body: Record<string, unknown>, method = 'POST') {
  const req = { method, body, headers: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & { statusCode: number; body: { success: boolean; error?: { code: string } } } };
}

const CUR = 'current-password';
const NEW = 'brand-new-password';

beforeEach(() => {
  vi.clearAllMocks();
  signIn.mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  adminUpdateUser.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
  rotateSessionRevokingOthers.mockResolvedValue({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 });
});

describe('POST /api/auth/change-password', () => {
  it('SECURITY: revokes other sessions and re-issues cookies on a successful change', async () => {
    const { req, res } = mockReqRes({ currentPassword: CUR, newPassword: NEW });
    await (changePasswordHandler as unknown as Handler)(req, res);
    expect(adminUpdateUser).toHaveBeenCalledWith('user-1', { password: NEW });
    // The revocation fires, keyed to the caller's account + new password.
    expect(rotateSessionRevokingOthers).toHaveBeenCalledWith('user@example.com', NEW);
    // The surviving fresh session is written back so the caller stays signed in.
    expect(setAuthCookies).toHaveBeenCalledWith(res, {
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresIn: 3600,
      persistent: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('SECURITY: fails closed (500) when revocation fails after the password changed', async () => {
    rotateSessionRevokingOthers.mockRejectedValueOnce(new Error('gotrue unreachable'));
    const { req, res } = mockReqRes({ currentPassword: CUR, newPassword: NEW });
    await (changePasswordHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error?.code).toBe('SESSION_REVOKE_FAILED');
    expect(setAuthCookies).not.toHaveBeenCalled();
  });

  it('rejects a wrong current password (400) and never revokes sessions', async () => {
    signIn.mockRejectedValueOnce(new Error('invalid credentials'));
    const { req, res } = mockReqRes({ currentPassword: 'wrong', newPassword: NEW });
    await (changePasswordHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('WRONG_PASSWORD');
    expect(adminUpdateUser).not.toHaveBeenCalled();
    expect(rotateSessionRevokingOthers).not.toHaveBeenCalled();
  });
});
