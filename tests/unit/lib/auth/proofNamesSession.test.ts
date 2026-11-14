/**
 * #1371 review LOW (WP9): a refused Return whose stash is gone may spend a look-up slot only with its own session's
 * Login-as proof. proofNamesSession accepts a proof this app minted for exactly that target session at ANY age, and
 * nothing else; validateImpersonationProof (the authorisation) still refuses it once it is an hour old.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintImpersonationProof, proofNamesSession, validateImpersonationProof } from '@/lib/auth/impersonationAssurance';

const SIGNING_KEY = 'proof-synthetic-'.repeat(4); // HS256 test key, not a credential
const target = { sub: 'target-1', session_id: 'session-1' };
const mint = () => {
  const now = Math.floor(Date.now() / 1000);
  return mintImpersonationProof({ actorUserId: 'admin-1', targetUserId: 'target-1', targetSessionId: 'session-1',
    actorExpiresAt: now + 3600, stashExpiresAt: now + 3600 });
};

describe('proofNamesSession', () => {
  beforeEach(() => { vi.stubEnv('JWT_SECRET', SIGNING_KEY); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('names its own session, also after it expired (validateImpersonationProof no longer accepts it)', async () => {
    const proof = await mint();
    expect(await proofNamesSession(proof, target)).toBe(true);
    vi.useFakeTimers({ now: Date.now() + 3 * 3600 * 1000 });
    expect(await validateImpersonationProof(proof, target)).toBe(false);
    expect(await proofNamesSession(proof, target)).toBe(true);
  });

  it('names no other session, no other target, and nothing for junk or another key', async () => {
    const proof = await mint();
    expect(await proofNamesSession(proof, { ...target, session_id: 'session-2' })).toBe(false);
    expect(await proofNamesSession(proof, { ...target, sub: 'target-2' })).toBe(false);
    expect(await proofNamesSession('junk', target)).toBe(false);
    vi.stubEnv('JWT_SECRET', 'another-synthetic-'.repeat(4));
    expect(await proofNamesSession(proof, target)).toBe(false);
  });
});
