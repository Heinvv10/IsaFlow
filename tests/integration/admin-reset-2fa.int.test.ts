// tests/integration/admin-reset-2fa.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { liveGoTrue } from '../helpers/liveGoTrue';
import { TOTP, Secret } from 'otpauth';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor, adminUnenrollFactor, adminListUserFactors } from '@/lib/auth/gotrue-mfa';

const TEST_EMAIL = `admin-reset-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaReset!123';

// ci-integration-skip: needs a live GoTrue at GOTRUE_URL (real sign-in, TOTP enrolment or the admin user API); the CI gate starts none.
const LIVE = await liveGoTrue();

describe.skipIf(!LIVE)('admin reset-2fa', () => {
  let userId: string;
  let factorId: string;

  beforeAll(async () => {
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const enroll = await enrollTotp(tok.access_token, TEST_EMAIL);
    factorId = enroll.factor_id;
    const totp = new TOTP({ secret: Secret.fromBase32(enroll.secret), digits: 6, period: 30 });
    const cid = await challengeFactor(factorId, tok.access_token);
    await verifyFactor(factorId, cid, totp.generate(), tok.access_token);
  });
  afterAll(async () => {
    try { await adminDeleteUser(userId); } catch { /* best-effort */ }
  });

  it('adminListUserFactors → adminUnenrollFactor → empty', async () => {
    // Pre-check: admin API sees the factor
    let factors = await adminListUserFactors(userId);
    expect(factors.some((f) => f.id === factorId)).toBe(true);

    await adminUnenrollFactor(userId, factorId);

    // Post-check (via admin API — avoids the user needing a valid AAL1 token)
    factors = await adminListUserFactors(userId);
    expect(factors.some((f) => f.id === factorId)).toBe(false);
  });
});
