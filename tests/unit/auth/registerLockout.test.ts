/**
 * POST /api/auth/register — the account-lockout paths.
 *
 * Registration is public and proves nothing about who owns an address, so every
 * branch that leaves a GoTrue user behind is a way to permanently block a
 * stranger's email: blocked at registration (user exists), unable to sign in
 * (unconfirmed), unable to verify (no link). These tests pin the two branches
 * that must not do that, plus the one that must still refuse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const {
  getUserMock, createUserMock, deleteUserMock,
  createTokenMock, invalidateMock, purgeMock, sendEmailMock, checkRateLimitMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createUserMock: vi.fn(),
  deleteUserMock: vi.fn(),
  createTokenMock: vi.fn(),
  invalidateMock: vi.fn(),
  purgeMock: vi.fn(),
  sendEmailMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/auth/gotrue', () => ({
  adminGetUserByEmail: getUserMock,
  adminCreateUser: createUserMock,
  adminDeleteUser: deleteUserMock,
}));
vi.mock('@/lib/auth/emailVerificationService', () => ({
  createEmailVerificationToken: createTokenMock,
  invalidateVerificationTokensForUser: invalidateMock,
  purgeExpiredVerificationTokens: purgeMock,
}));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/email-templates-shared', () => ({
  emailLayout: (s: string) => s,
  ctaButton: (label: string, url: string) => `${label}:${url}`,
}));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: checkRateLimitMock,
  withRateLimit: (h: unknown) => h,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import handler from '@/../pages/api/auth/register';

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: { success: boolean; data?: unknown } };
}

const body = {
  email: 'Victim@Example.co.za',
  password: 'CorrectHorseBattery1',
  companyName: 'Victim Co',
  firstName: 'Vic',
  lastName: 'Tim',
};

function mockReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', body: { ...body, ...overrides }, headers: {}, socket: {} } as unknown as NextApiRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimitMock.mockResolvedValue(true);
  createUserMock.mockResolvedValue({ id: 'new-user' });
  createTokenMock.mockResolvedValue({ token: 'a'.repeat(64), expiresAt: new Date() });
  sendEmailMock.mockResolvedValue(undefined);
  deleteUserMock.mockResolvedValue(undefined);
  purgeMock.mockResolvedValue({ removed: 0, abandonedUserIds: [] });
  invalidateMock.mockResolvedValue(0);
});

describe('register — existing account handling', () => {
  it('refuses when a CONFIRMED account already owns the address', async () => {
    getUserMock.mockResolvedValue({ id: 'real-user', email_confirmed_at: '2026-01-01T00:00:00Z' });
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.statusCode).toBe(400);
    expect(createUserMock).not.toHaveBeenCalled();
    // The real owner's account must never be touched by a stranger's signup.
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it('discards an UNCONFIRMED leftover so a squatted address stays registerable', async () => {
    // An attacker registering victim@ must not lock the victim out forever.
    getUserMock.mockResolvedValue({ id: 'squatter-user', email_confirmed_at: undefined });
    const res = mockRes();

    await handler(mockReq(), res);

    expect(deleteUserMock).toHaveBeenCalledWith('squatter-user');
    expect(createUserMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(202);
  });

  it("kills the discarded user's live tokens before deleting it", async () => {
    // Deleting the GoTrue user does not touch its tokens, and
    // company_users.user_id has no FK — so a surviving link would provision a
    // tenant owned by a user that no longer exists.
    getUserMock.mockResolvedValue({ id: 'squatter-user', email_confirmed_at: undefined });
    const order: string[] = [];
    invalidateMock.mockImplementation(async () => { order.push('invalidate'); return 1; });
    deleteUserMock.mockImplementation(async () => { order.push('delete'); });

    await handler(mockReq(), mockRes());

    expect(invalidateMock).toHaveBeenCalledWith('squatter-user');
    expect(order).toEqual(['invalidate', 'delete']);
  });

  it('does not proceed if the leftover could not be discarded', async () => {
    // Creating a second GoTrue user for the same address is worse than failing.
    getUserMock.mockResolvedValue({ id: 'stuck-user', email_confirmed_at: undefined });
    deleteUserMock.mockRejectedValue(new Error('gotrue down'));
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.statusCode).toBe(503);
    expect(createUserMock).not.toHaveBeenCalled();
  });
});

describe('register — failure cleanup', () => {
  beforeEach(() => {
    getUserMock.mockRejectedValue(new Error('not found'));
  });

  it('creates the user UNCONFIRMED', async () => {
    await handler(mockReq(), mockRes());
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ email_confirm: false }),
    );
  });

  it('deletes the user when the confirmation email cannot be sent', async () => {
    // Otherwise the address holds an unconfirmed user whose link never arrived:
    // unusable and unregisterable.
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.statusCode).toBe(502);
    expect(deleteUserMock).toHaveBeenCalledWith('new-user');
  });

  it('deletes the user when the token could not be minted', async () => {
    createTokenMock.mockRejectedValue(new Error('db down'));

    await expect(handler(mockReq(), mockRes())).rejects.toThrow('db down');
    expect(deleteUserMock).toHaveBeenCalledWith('new-user');
  });

  it('accepts a clean signup without creating anything durable', async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.statusCode).toBe(202);
    expect(res.body.data).toMatchObject({ pendingVerification: true });
    // The ops notification must not fire until the address is verified.
    const subjects = sendEmailMock.mock.calls.map((c) => (c[0] as { subject: string }).subject);
    expect(subjects).toEqual(['Confirm your email to activate ISAFlow']);
  });

  it('normalises the email before use', async () => {
    await handler(mockReq(), mockRes());
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'victim@example.co.za' }),
    );
  });

  it('rejects an over-maximum turnover rather than silently dropping it', async () => {
    const res = mockRes();
    await handler(mockReq({ annualTurnover: 99_999_999_999_999 }), res);

    expect(res.statusCode).toBe(400);
    expect(createUserMock).not.toHaveBeenCalled();
  });
});
