/**
 * app-router's getUserFromRequest establishes identity from a GoTrue JWT for
 * App Router routes. It currently has ZERO callers, which is precisely why it
 * is gated: an ungated identity helper sitting in the tree is the next
 * suspended-user hole, adopted by whoever writes the first App Router route.
 * Zero callers also means zero regression risk in gating it now.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TEST_SECRET = 'a'.repeat(40);
process.env.JWT_SECRET = TEST_SECRET;
process.env.GOTRUE_URL = 'http://example.test/auth/v1';

const requireActiveAccount = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('@/lib/auth/requireActiveAccount', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccount(...a),
}));

import { SignJWT } from 'jose';
import { getUserFromRequest } from '@/lib/auth/app-router';

async function tok() {
  return new SignJWT({ sub: 'user-1', email: 'u@e.z', aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkReq(token: string) {
  return {
    cookies: { get: (k: string) => (k === 'sb-access-token' ? { value: token } : undefined) },
    headers: { get: () => null },
  } as never;
}

beforeEach(() => { vi.clearAllMocks(); requireActiveAccount.mockResolvedValue(null); });

describe('app-router getUserFromRequest — suspended account gate', () => {
  it('resolves an active user', async () => {
    const user = await getUserFromRequest(mkReq(await tok()));
    expect(user?.id).toBe('user-1');
  });

  it('SECURITY: resolves to null for a suspended user, so callers 401', async () => {
    requireActiveAccount.mockResolvedValue({ code: 'ACCOUNT_SUSPENDED', message: 'x' });
    const user = await getUserFromRequest(mkReq(await tok()));
    expect(user).toBeNull();
  });
});
