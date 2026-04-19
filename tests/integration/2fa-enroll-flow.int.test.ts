// tests/integration/2fa-enroll-flow.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, listFactors, challengeFactor, verifyFactor, unenrollFactor } from '@/lib/auth/gotrue-mfa';

if (!process.env.JWT_SECRET || !process.env.GOTRUE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('JWT_SECRET + GOTRUE_URL + SUPABASE_SERVICE_ROLE_KEY required');
}

const TEST_EMAIL = `2fa-enroll-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaSecret!123';

describe('2FA enroll flow (against dev GoTrue)', () => {
  let userId: string;
  let accessToken: string;

  beforeAll(async () => {
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    accessToken = tok.access_token;
  });
  afterAll(async () => {
    try { await adminDeleteUser(userId); } catch { /* best-effort cleanup */ }
  });

  it('enroll → challenge → verify → listFactors shows verified', async () => {
    const enroll = await enrollTotp(accessToken, TEST_EMAIL);
    expect(enroll.factor_id).toBeTruthy();
    expect(enroll.secret).toMatch(/^[A-Z2-7]+$/); // base32

    const totp = new TOTP({ secret: Secret.fromBase32(enroll.secret), digits: 6, period: 30 });
    const code = totp.generate();

    const challengeId = await challengeFactor(enroll.factor_id, accessToken);
    const aal2 = await verifyFactor(enroll.factor_id, challengeId, code, accessToken);
    expect(aal2.access_token).toBeTruthy();

    const factors = await listFactors(aal2.access_token);
    const verified = factors.totp.filter((f) => f.status === 'verified');
    expect(verified.length).toBeGreaterThanOrEqual(1);

    // Cleanup — unenroll so user can be deleted cleanly
    await unenrollFactor(enroll.factor_id, aal2.access_token);
  });
});
