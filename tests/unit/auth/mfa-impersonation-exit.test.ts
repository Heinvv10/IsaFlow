import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiRequest, NextApiResponse } from 'next';
const fixture = vi.hoisted(() => ({ loadStash: vi.fn(), deleteStash: vi.fn() }));
vi.mock('@/modules/admin/services/userImpersonationService', () => fixture);
vi.mock('@/lib/neon', () => ({ sql: async () => [] }));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrf: () => true }));
import handler from '../../../pages/api/auth/end-impersonation';
import { ADMIN_STASH_COOKIE } from '@/lib/auth/impersonation-cookies';

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'synthetic-impersonation-exit-signing-secret-forty-characters');
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  fixture.loadStash.mockResolvedValue({ target_user_id: 'target-user', admin_user_id: 'admin-user',
    admin_access_token: 'prior-admin-token', admin_refresh_token: 'prior-admin-refresh' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'target-user',
    factors: [{ status: 'verified', factor_type: 'totp' }] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['target-user', 'unrelated-user'])('restoring the admin session retains stash ownership checks: %s', async (sub) => {
  const token = await new SignJWT({ sub, aal: 'aal1' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
    setHeader(key: string, value: unknown) { headers.set(key.toLowerCase(), value); },
    getHeader(key: string) { return headers.get(key.toLowerCase()); },
  };
  await handler({ method: 'POST', headers: {
    cookie: `sb-access-token=${token}; ${ADMIN_STASH_COOKIE}=synthetic-stash`,
  } } as NextApiRequest, res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(sub === 'target-user' ? 200 : 403);
  expect(fixture.deleteStash).toHaveBeenCalledTimes(sub === 'target-user' ? 1 : 0);
});
