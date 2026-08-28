// tests/integration/2fa-login-gate.int.test.ts
// Drives /api/auth/login through the actual handler to confirm the MFA gate.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NextApiResponse } from 'next';
import { TOTP, Secret } from 'otpauth';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor, unenrollFactor } from '@/lib/auth/gotrue-mfa';
import loginHandler from '../../pages/api/auth/login';
import challengeHandler from '../../pages/api/auth/2fa-challenge';

if (!process.env.JWT_SECRET || !process.env.GOTRUE_URL || !process.env.DATABASE_URL) {
  throw new Error('JWT_SECRET + GOTRUE_URL + DATABASE_URL required');
}

const TEST_EMAIL = `2fa-gate-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaGate!123';

function mkReq(body: unknown, cookieHeader?: string) {
  // `socket` is required: the exported login handler is wrapped in withRateLimit,
  // whose getClientIp() falls back to req.socket.remoteAddress when there is no
  // x-forwarded-for header. Omitting it throws before the handler ever runs.
  return {
    method: 'POST',
    body,
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    url: '/api/auth/login',
    socket: { remoteAddress: '127.0.0.1' },
  } as never;
}

/**
 * Rebuild a request Cookie header from the Set-Cookie headers a handler emitted.
 * The 2FA challenge handler reads pending_token ONLY from the HttpOnly cookie
 * (pentest H6/M8) — passing it in the body is ignored and yields NO_PENDING_TOKEN.
 */
function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
function mkRes() {
  let status = 200; let body: unknown; const setCookies: string[] = [];
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader(k: string, v: string | string[]) {
      if (k.toLowerCase() === 'set-cookie') setCookies.push(...(Array.isArray(v) ? v : [v]));
    },
    getHeader(k: string) { return k.toLowerCase() === 'set-cookie' ? setCookies : undefined; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; }, get cookies() { return setCookies; } };
}

describe('login MFA gate', () => {
  let userId: string;
  let secret: string;
  let factorId: string;

  beforeAll(async () => {
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const enroll = await enrollTotp(tok.access_token, TEST_EMAIL);
    factorId = enroll.factor_id;
    secret = enroll.secret;
    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const challengeId = await challengeFactor(factorId, tok.access_token);
    await verifyFactor(factorId, challengeId, totp.generate(), tok.access_token);
  });
  afterAll(async () => {
    try {
      const tok = await signIn(TEST_EMAIL, TEST_PW);
      await unenrollFactor(factorId, tok.access_token);
    } catch { /* best-effort */ }
    try { await adminDeleteUser(userId); } catch { /* best-effort */ }
  });

  it('login with TOTP factor returns requires_2fa: true and NO cookie', async () => {
    const r = mkRes();
    await loginHandler(mkReq({ email: TEST_EMAIL, password: TEST_PW }), r.res);
    expect(r.status).toBe(200);
    expect((r.body as { data: { requires_2fa?: true; factor_id?: string; pending_token?: string } }).data.requires_2fa).toBe(true);
    expect((r.body as { data: { factor_id?: string } }).data.factor_id).toBe(factorId);
    expect(r.cookies.some((c: string) => c.startsWith('sb-access-token='))).toBe(false);
  });

  it('challenge endpoint sets sb-access-token cookie when code valid', async () => {
    const loginRes = mkRes();
    await loginHandler(mkReq({ email: TEST_EMAIL, password: TEST_PW }), loginRes.res);
    const { factor_id } = (loginRes.body as { data: { factor_id: string } }).data;

    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const r2 = mkRes();
    await challengeHandler(
      mkReq({ factor_id, code: totp.generate(), pending_token: '' }, cookieHeaderFrom(loginRes.cookies)),
      r2.res
    );
    expect(r2.status).toBe(200);
    expect(r2.cookies.some((c: string) => c.startsWith('sb-access-token='))).toBe(true);
  });
});
