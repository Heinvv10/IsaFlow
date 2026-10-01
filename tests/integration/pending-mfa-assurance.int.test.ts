import { mintImpersonationProof } from '@/lib/auth/impersonationAssurance';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { Secret, TOTP } from 'otpauth';
import { adminCreateUser, adminDeleteUser, signIn, refresh, verifyToken, verifyTokenSignature } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor } from '@/lib/auth/gotrue-mfa';

// Explicit opt-in guards this test's user creation against accidental shared-host runs.
const provider = new URL(process.env.GOTRUE_URL ?? 'http://missing.invalid');
if (process.env.ISAFLOW_DISPOSABLE_AUTH_TEST !== '1' || !['127.0.0.1', 'localhost'].includes(provider.hostname)) {
  throw new Error('Requires ISAFLOW_DISPOSABLE_AUTH_TEST=1 and localhost disposable GOTRUE_URL');
}
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('Disposable JWT_SECRET required');
const email = `mfa-remediation-${crypto.randomUUID()}@test.local`;
const password = 'Disposable-Mfa-Test!2026';
let userId: string | undefined;
let priorAnon: string | undefined;
let priorService: string | undefined;

beforeAll(async () => {
  priorAnon = process.env.SUPABASE_ANON_KEY;
  priorService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = new TextEncoder().encode(secret);
  const mint = (role: string) => new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(key);
  process.env.SUPABASE_ANON_KEY = await mint('anon');
  process.env.SUPABASE_SERVICE_ROLE_KEY = await mint('service_role');
  userId = (await adminCreateUser({ email, password, email_confirm: true })).id;
});
afterAll(async () => {
  try {
    if (userId) await adminDeleteUser(userId);
  } finally {
    if (priorAnon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = priorAnon;
    if (priorService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorService;
  }
});

it('real GoTrue: no-MFA login, enrollment, denied password token, then completed TOTP session', async () => {
  const initial = await signIn(email, password);
  expect((await verifyToken(initial.access_token)).sub).toBe(userId);
  const enrollment = await enrollTotp(initial.access_token, 'remediation fixture');
  // An unverified enrollment must not lock the user out of finishing setup.
  expect((await verifyToken(initial.access_token)).sub).toBe(userId);
  const totp = new TOTP({ secret: Secret.fromBase32(enrollment.secret), digits: 6, period: 30 });
  const code = totp.generate();
  await verifyFactor(enrollment.factor_id, await challengeFactor(enrollment.factor_id, initial.access_token), code, initial.access_token);

  const pending = await signIn(email, password);
  expect((await verifyTokenSignature(pending.access_token)).aal).toBe('aal1');
  await expect(verifyToken(pending.access_token)).rejects.toThrow('MFA challenge required');
  const pendingClaims = await verifyTokenSignature(pending.access_token);
  expect(typeof pendingClaims.session_id).toBe('string');
  const proof = await mintImpersonationProof({ actorUserId: 'synthetic-authorized-admin',
    targetUserId: userId!, targetSessionId: pendingClaims.session_id as string,
    actorExpiresAt: Math.floor(Date.now() / 1000) + 120, stashExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
  expect((await verifyToken(pending.access_token, proof)).aal).toBe('aal1');
  const rotated = await refresh(pending.refresh_token);
  expect((await verifyTokenSignature(rotated.access_token)).session_id).toBe(pendingClaims.session_id);
  expect((await verifyToken(rotated.access_token, proof)).aal).toBe('aal1');
  await expect(verifyToken(rotated.access_token)).rejects.toThrow('MFA challenge required');


  // GoTrue rejects reuse of the enrollment OTP. Wait for the next real step.
  const remaining = 30_000 - (Date.now() % 30_000) + 50;
  await new Promise((resolve) => setTimeout(resolve, remaining));
  const complete = await verifyFactor(enrollment.factor_id,
    await challengeFactor(enrollment.factor_id, pending.access_token), totp.generate(), pending.access_token);
  expect((await verifyToken(complete.access_token)).aal).toBe('aal2');
}, 60_000);
