import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeJwt, SignJWT } from 'jose';
import { createHmac } from 'crypto';
import { mintImpersonationProof, validateImpersonationProof } from '@/lib/auth/impersonationAssurance';

const delegation = vi.hoisted(() => ({ live: vi.fn(async () => true) }));
vi.mock('@/lib/auth/impersonationDelegation', () => ({ impersonationDelegationLive: delegation.live }));

const now = Math.floor(Date.now() / 1000);
const stashId = '11111111-1111-4111-8111-111111111111';
const input = { actorUserId: 'actor', targetUserId: 'target', targetSessionId: 'session', stashId,
  actorExpiresAt: now + 60, stashExpiresAt: now + 3600 };
beforeEach(() => { delegation.live.mockReset(); delegation.live.mockResolvedValue(true);
  vi.stubEnv('JWT_SECRET', 'disposable-delegation-signing-secret-at-least-forty-characters'); });
afterEach(() => vi.unstubAllEnvs());
it('binds the proof to a target session and preserves the actor expiry ceiling', async () => {
  const proof = await mintImpersonationProof(input);
  expect(decodeJwt(proof).exp).toBe(input.actorExpiresAt);
  expect(decodeJwt(proof).sub).toBeUndefined();
  expect(await validateImpersonationProof(proof, { sub: 'target', session_id: 'session' })).toBe(true);
});
it('bounds proof lifetime to the stash expiry too', async () => {
  const proof = await mintImpersonationProof({ ...input, stashExpiresAt: now + 10 });
  expect(decodeJwt(proof).exp).toBe(now + 10);
});
it.each([{ sub: 'other', session_id: 'session' }, { sub: 'target', session_id: 'other' },
  { sub: 'target' }, { sub: '', session_id: 'session' }])('rejects target/session mismatch %j', async (claims) => {
  expect(await validateImpersonationProof(await mintImpersonationProof(input), claims)).toBe(false);
});
it('is refused once the delegation it names is no longer live', async () => {
  const proof = await mintImpersonationProof(input);
  delegation.live.mockResolvedValue(false);
  expect(await validateImpersonationProof(proof, { sub: 'target', session_id: 'session' })).toBe(false);
  expect(delegation.live).toHaveBeenCalledWith(stashId, 'actor', 'target', 'session');
});
it('refuses a proof that names no stash row at all', async () => {
  const key = createHmac('sha256', process.env.JWT_SECRET!).update('isaflow:impersonation-assurance:v1').digest();
  const legacy = await new SignJWT({ version: 1, actorUserId: 'actor', targetUserId: 'target', targetSessionId: 'session' })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt(now - 10).setIssuer('isaflow')
    .setAudience('isaflow-impersonation').setExpirationTime(now + 60).sign(key);
  expect(await validateImpersonationProof(legacy, { sub: 'target', session_id: 'session' })).toBe(false);
});
it.each([{ actorUserId: '' }, { targetSessionId: '' }, { stashId: '' }, { actorExpiresAt: NaN },
  { actorExpiresAt: now - 1 }, { stashExpiresAt: Infinity }])('refuses invalid issuance %j', async (change) => {
  await expect(mintImpersonationProof({ ...input, ...change })).rejects.toThrow();
});
it('rejects tampering and another signing key', async () => {
  const proof = await mintImpersonationProof(input);
  expect(await validateImpersonationProof(`x${proof}`, { sub: 'target', session_id: 'session' })).toBe(false);
  vi.stubEnv('JWT_SECRET', 'another-disposable-delegation-signing-secret-at-least-forty-characters');
  expect(await validateImpersonationProof(proof, { sub: 'target', session_id: 'session' })).toBe(false);
});

it.each(['issuer', 'audience', 'version', 'expired'])('rejects a correctly signed proof with invalid %s', async (defect) => {
  const key = createHmac('sha256', process.env.JWT_SECRET!).update('isaflow:impersonation-assurance:v1').digest();
  const proof = await new SignJWT({ version: defect === 'version' ? 2 : 1,
    actorUserId: 'actor', targetUserId: 'target', targetSessionId: 'session', stashId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt(now - 10)
    .setIssuer(defect === 'issuer' ? 'other' : 'isaflow')
    .setAudience(defect === 'audience' ? 'other' : 'isaflow-impersonation')
    .setExpirationTime(defect === 'expired' ? now - 1 : now + 60).sign(key);
  expect(await validateImpersonationProof(proof, { sub: 'target', session_id: 'session' })).toBe(false);
});
