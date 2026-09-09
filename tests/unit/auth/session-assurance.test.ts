import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { verifyToken, verifyTokenSignature } from '@/lib/auth/gotrue';

const secret = 'synthetic-session-assurance-secret-over-forty-characters';
const userId = '00000000-0000-0000-0000-000000000aa1';
async function token(aal = 'aal1', expiry = '1h') {
  return new SignJWT({ sub: userId, aal }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiry).sign(new TextEncoder().encode(secret));
}
beforeEach(() => {
  vi.stubEnv('JWT_SECRET', secret);
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('completed session assurance', () => {
  it.each(['totp', 'phone'])('denies password tokens with verified %s factors', async (factor_type) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: userId,
      factors: [{ id: 'factor-1', status: 'verified', factor_type }] })));
    await expect(verifyToken(await token())).rejects.toThrow('MFA challenge required');
  });
  it.each([{ factors: [] }, { factors: [{ status: 'unverified', factor_type: 'totp' }] }])('permits an unenrolled or unfinished enrollment', async ({ factors }) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: userId, factors })));
    await expect(verifyToken(await token())).resolves.toMatchObject({ sub: userId });
  });
  it('permits provider responses omitting factors for an unenrolled user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: userId })));
    await expect(verifyToken(await token())).resolves.toMatchObject({ sub: userId });
  });
  it('accepts signed AAL2 without a provider lookup', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(verifyToken(await token('aal2'))).resolves.toMatchObject({ sub: userId });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps signature-only verification available to the pending challenge', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(verifyTokenSignature(await token())).resolves.toMatchObject({ sub: userId });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, {}, { id: 'other-user', factors: [] }, { id: userId, factors: null },
    { id: userId, factors: [{}] }, { id: userId, factors: ['unverified'] }])('denies malformed or mismatched identity state: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
    await expect(verifyToken(await token())).rejects.toThrow();
  });
  it('denies a provider error instead of treating enrollment as absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(verifyToken(await token())).rejects.toThrow('Session assurance check failed');
  });
  it('denies a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(verifyToken(await token())).rejects.toThrow('offline');
  });
  it('denies expired tokens before requesting factor state', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(verifyToken(await token('aal1', '-1h'))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
