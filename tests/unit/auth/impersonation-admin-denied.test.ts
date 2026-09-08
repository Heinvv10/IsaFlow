import { afterEach, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiRequest, NextApiResponse } from 'next';
const fixture = vi.hoisted(() => ({
  privilegedConnect: vi.fn(), validateTarget: vi.fn(), stash: vi.fn(), mint: vi.fn(),
}));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  getAppPool: () => ({ connect: async () => ({ release: vi.fn(), query: async (query: string) => ({
    rows: query.includes('SELECT role') ? [{ role: 'viewer', is_active: true, status: 'active', suspended_at: null }] : [],
  }) }) }),
  getPlatformAdminPool: () => ({ connect: fixture.privilegedConnect }),
}));
vi.mock('@/modules/admin/services/userImpersonationService', () => ({
  validateImpersonationTarget: fixture.validateTarget, stashAdminTokens: fixture.stash,
  loadStash: vi.fn(), deleteStash: vi.fn(),
}));
vi.mock('@/lib/auth/impersonationAssurance', () => ({
  mintImpersonationProof: fixture.mint, validateImpersonationProof: vi.fn(async () => false),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
import handler from '../../../pages/api/admin/users/[id]/impersonate';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('real admin wrapper rejects a non-admin before provider, stash or delegation issuance', async () => {
  const secret = 'disposable-admin-denial-signing-secret-at-least-forty-characters';
  vi.stubEnv('JWT_SECRET', secret);
  const token = await new SignJWT({ sub: 'viewer-user', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  const headers = new Map<string, unknown>();
  const res = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
    json() { return this; }, getHeader(key: string) { return headers.get(key); },
    setHeader(key: string, value: unknown) { headers.set(key, value); } };
  await handler({ method: 'POST', query: { id: 'target-user' },
    headers: { cookie: `sb-access-token=${token}` },
  } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(403);
  expect(fixture.privilegedConnect).not.toHaveBeenCalled();
  expect(fixture.validateTarget).not.toHaveBeenCalled();
  expect(fixture.stash).not.toHaveBeenCalled();
  expect(fixture.mint).not.toHaveBeenCalled();
  expect(headers.get('Set-Cookie')).toBeUndefined();
});
