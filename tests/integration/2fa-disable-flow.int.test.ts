// tests/integration/2fa-disable-flow.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor, listFactors } from '@/lib/auth/gotrue-mfa';

const TEST_EMAIL = `2fa-disable-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaDisable!123';

describe('2fa disable flow', () => {
  let userId: string;
  let factorId: string;
  let secret: string;

  beforeAll(async () => {
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const enroll = await enrollTotp(tok.access_token, TEST_EMAIL);
    factorId = enroll.factor_id;
    secret = enroll.secret;
    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const cid = await challengeFactor(factorId, tok.access_token);
    await verifyFactor(factorId, cid, totp.generate(), tok.access_token);
  });
  afterAll(async () => {
    try { await adminDeleteUser(userId); } catch { /* best-effort */ }
  });

  it('disabling removes the factor so listFactors returns zero verified', async () => {
    const { default: disableHandler } = await import('../../pages/api/auth/2fa-disable');
    // Re-login to get a fresh access token. Because user still has a verified factor,
    // signIn returns an AAL1 token; we use it for the challenge+verify inside disable.
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });

    const res = {
      status(_c: number) { return this; },
      json(_v: unknown) { return this; },
      setHeader() { /* noop */ },
      getHeader() { return undefined; },
    } as never;
    const req = {
      method: 'POST',
      headers: { cookie: `sb-access-token=${tok.access_token}` },
      body: { factor_id: factorId, code: totp.generate() },
      url: '/api/auth/2fa-disable',
    } as never;
    await disableHandler(req, res);

    const factors = await listFactors(tok.access_token);
    expect(factors.totp.filter((f) => f.status === 'verified')).toHaveLength(0);
  });
});
