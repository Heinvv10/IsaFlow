/**
 * /api/auth/2fa-enroll establishes identity and then mutates the account's
 * security configuration (adds a TOTP factor). Lower consequence than the
 * session-minting paths — the account is closed either way — but a suspended
 * user should not be changing security settings on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const TEST_SECRET = 'a'.repeat(40);
process.env.JWT_SECRET = TEST_SECRET;
process.env.GOTRUE_URL = 'http://example.test/auth/v1';

const cookieJar = vi.hoisted(() => ({ access: '' }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/cookies', () => ({
  parseCookies: () => ({ 'sb-access-token': cookieJar.access }),
  ACCESS_COOKIE: 'sb-access-token',
}));

const enrollTotp = vi.hoisted(() => vi.fn(async () => ({ factor_id: 'f1', qr_code: 'data:...' })));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  enrollTotp: (...a: unknown[]) => enrollTotp(...a),
  GotrueMfaError: class GotrueMfaError extends Error { status = 400; },
}));

const requireActiveAccount = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('@/lib/auth/requireActiveAccount', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccount(...a),
}));

import { SignJWT } from 'jose';
import enrollHandler from '../../../../pages/api/auth/2fa-enroll';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

async function tok() {
  return new SignJWT({ sub: 'user-1', email: 'u@e.z', aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkReqRes() {
  const req = { method: 'POST', body: {}, headers: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & { statusCode: number; body: { error?: { code: string } } } };
}

beforeEach(async () => {
  vi.clearAllMocks();
  cookieJar.access = await tok();
  requireActiveAccount.mockResolvedValue(null);
  enrollTotp.mockResolvedValue({ factor_id: 'f1', qr_code: 'data:...' });
});

describe('POST /api/auth/2fa-enroll — suspended account gate', () => {
  it('enrols a factor for an active user', async () => {
    const { req, res } = mkReqRes();
    await (enrollHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(enrollTotp).toHaveBeenCalled();
  });

  it('SECURITY: a suspended user cannot enrol a factor', async () => {
    requireActiveAccount.mockResolvedValue({ code: 'ACCOUNT_SUSPENDED', message: 'x' });
    const { req, res } = mkReqRes();
    await (enrollHandler as unknown as Handler)(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
    expect(enrollTotp).not.toHaveBeenCalled();
  });
});
