/**
 * Unit tests for the password-reset API handlers.
 *
 * Covers the security-critical response contract that the service-level tests
 * cannot reach:
 *  - do-reset-password: weak/oversized password → 400; invalid token → 400 and
 *    NO password update; a failure AFTER the token is spent → 500 (not a
 *    misleading "invalid token" 400)
 *  - forgot-password: always 200 (no account enumeration), even for an unknown
 *    email, and the mint+email work is detached from the response
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Rate-limit wrapper is a pass-through in tests; limiter always allows.
vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const consumePasswordResetToken = vi.fn();
const createPasswordResetToken = vi.fn();
vi.mock('@/lib/auth/passwordResetService', () => ({
  consumePasswordResetToken: (...a: unknown[]) => consumePasswordResetToken(...a),
  createPasswordResetToken: (...a: unknown[]) => createPasswordResetToken(...a),
}));

const adminUpdateUser = vi.fn();
const adminGetUserByEmail = vi.fn();
vi.mock('@/lib/auth/gotrue', () => ({
  adminUpdateUser: (...a: unknown[]) => adminUpdateUser(...a),
  adminGetUserByEmail: (...a: unknown[]) => adminGetUserByEmail(...a),
}));

const revokeAllSessions = vi.fn(async () => undefined);
vi.mock('@/lib/auth/sessionRevocation', () => ({
  revokeAllSessions: (...a: unknown[]) => revokeAllSessions(...a),
  rotateSessionRevokingOthers: vi.fn(),
}));

const sendEmail = vi.fn(async () => ({ success: true }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock('@/lib/email-templates-shared', () => ({ emailLayout: (s: string) => s, ctaButton: (l: string, u: string) => `${l}:${u}` }));

import doResetHandler from '../../../../pages/api/auth/do-reset-password';
import forgotHandler from '../../../../pages/api/auth/forgot-password';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

function mockReqRes(body: Record<string, unknown>, method = 'POST') {
  const req = { method, body } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & { statusCode: number; body: { success: boolean; error?: { code: string } } } };
}

const VALID_PW = 'longenoughpassword';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/do-reset-password', () => {
  it('rejects a too-short password with 400 WEAK_PASSWORD and never touches the token', async () => {
    const { req, res } = mockReqRes({ recoveryToken: 't', newPassword: 'short' });
    await (doResetHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('WEAK_PASSWORD');
    expect(consumePasswordResetToken).not.toHaveBeenCalled();
  });

  it('rejects an oversized password with 400 WEAK_PASSWORD', async () => {
    const { req, res } = mockReqRes({ recoveryToken: 't', newPassword: 'x'.repeat(201) });
    await (doResetHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('WEAK_PASSWORD');
  });

  it('returns 400 INVALID_RECOVERY_TOKEN and does NOT update the password for a bad token', async () => {
    consumePasswordResetToken.mockResolvedValueOnce(null);
    const { req, res } = mockReqRes({ recoveryToken: 'bad', newPassword: VALID_PW });
    await (doResetHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_RECOVERY_TOKEN');
    expect(adminUpdateUser).not.toHaveBeenCalled();
  });

  it('updates the password and returns 200 for a valid token', async () => {
    consumePasswordResetToken.mockResolvedValueOnce({ userId: 'user-9' });
    adminUpdateUser.mockResolvedValueOnce({ id: 'user-9', email: 'u9@example.com' });
    const { req, res } = mockReqRes({ recoveryToken: 'good', newPassword: VALID_PW });
    await (doResetHandler as unknown as Handler)(req, res);
    expect(adminUpdateUser).toHaveBeenCalledWith('user-9', { password: VALID_PW });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('SECURITY: revokes ALL sessions after a successful reset', async () => {
    consumePasswordResetToken.mockResolvedValueOnce({ userId: 'user-9' });
    adminUpdateUser.mockResolvedValueOnce({ id: 'user-9', email: 'u9@example.com' });
    const { req, res } = mockReqRes({ recoveryToken: 'good', newPassword: VALID_PW });
    await (doResetHandler as unknown as Handler)(req, res);
    // The whole point of a reset: stale GoTrue refresh tokens must be revoked,
    // keyed to the account whose password just changed.
    expect(revokeAllSessions).toHaveBeenCalledWith('u9@example.com', VALID_PW);
    expect(res.statusCode).toBe(200);
  });

  it('SECURITY: fails closed (500) when session revocation fails after the reset', async () => {
    consumePasswordResetToken.mockResolvedValueOnce({ userId: 'user-9' });
    adminUpdateUser.mockResolvedValueOnce({ id: 'user-9', email: 'u9@example.com' });
    revokeAllSessions.mockRejectedValueOnce(new Error('gotrue unreachable'));
    const { req, res } = mockReqRes({ recoveryToken: 'good', newPassword: VALID_PW });
    await (doResetHandler as unknown as Handler)(req, res);
    // Never report the account secured when stale sessions may still be live.
    expect(res.statusCode).toBe(500);
    expect(res.body.error?.code).toBe('RESET_FAILED');
  });

  it('returns 500 (not a misleading 400) when the update fails AFTER the token is spent', async () => {
    consumePasswordResetToken.mockResolvedValueOnce({ userId: 'user-9' });
    adminUpdateUser.mockRejectedValueOnce(new Error('gotrue down'));
    const { req, res } = mockReqRes({ recoveryToken: 'good', newPassword: VALID_PW });
    await (doResetHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error?.code).toBe('RESET_FAILED');
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('returns 200 for an existing email', async () => {
    adminGetUserByEmail.mockResolvedValueOnce({ id: 'user-1' });
    createPasswordResetToken.mockResolvedValueOnce({ token: 'tok', expiresAt: new Date(Date.now() + 1000) });
    const { req, res } = mockReqRes({ email: 'real@example.com' });
    await (forgotHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 200 for an unknown email too (no enumeration) and does not throw', async () => {
    adminGetUserByEmail.mockRejectedValueOnce(new Error('no gotrue user'));
    const { req, res } = mockReqRes({ email: 'ghost@example.com' });
    await (forgotHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects a missing email with 400', async () => {
    const { req, res } = mockReqRes({});
    await (forgotHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(400);
  });
});
