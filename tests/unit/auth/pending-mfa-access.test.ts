import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiRequest, NextApiResponse } from 'next';

const fixtures = vi.hoisted(() => ({
  companyId: '00000000-0000-0000-0000-000000000cc1',
  userId: '00000000-0000-0000-0000-000000000aa1',
  sql: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: fixtures.sql }));
vi.mock('@/lib/auth/authPool', () => ({ getAuthPool: () => ({
  connect: async () => ({ query: fixtures.query, release: fixtures.release }),
}) }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: async () => true,
  getClientIp: () => '127.0.0.1',
  withRateLimit: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: async () => ({ locked: false }),
  recordFailure: vi.fn(),
  clearLockout: vi.fn(),
}));

import login from '../../../pages/api/auth/login';
import { withAuth } from '@/lib/auth/withAuth';

function response() {
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    json(body: unknown) { this.body = body; return this.end(); },
    end() { return this; },
  };
  return { res: res as unknown as NextApiResponse, headers, state: res };
}
function request(cookie?: string): NextApiRequest {
  return { method: 'POST', url: '/api/auth/login', headers: { cookie },
    body: { email: 'mfa@test.local', password: 'synthetic-password' },
    socket: { remoteAddress: '127.0.0.1' },
  } as NextApiRequest;
}

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'local-test-signing-secret-with-at-least-forty-characters');
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'local-test-anon');
  vi.stubEnv('SENTRY_ENABLED', 'false');
  fixtures.sql.mockResolvedValue([{ is_active: true, status: 'active', suspended_at: null,
    company_id: fixtures.companyId, is_default: true }]);
  fixtures.query.mockImplementation(async (query: string) => ({ command: query.trim().split(/\s+/)[0]!.toUpperCase(), rows: query.includes('FROM company_users')
    ? [{ role: 'admin', account_user_id: fixtures.userId, is_active: true, status: 'active', suspended_at: null }]
    : [] }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('K-001: password token cannot replace a completed MFA session', () => {
  it.each([true, false])('verified factor enrolled: %s', async (enrolled) => {
    const token = await new SignJWT({ sub: fixtures.userId, email: 'mfa@test.local',
      role: 'authenticated', aal: 'aal1', amr: [{ method: 'password', timestamp: 1 }] })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/token?grant_type=password')) {
        return Response.json({ access_token: token, refresh_token: 'synthetic-refresh',
          expires_in: 3600, token_type: 'bearer', user: { id: fixtures.userId, email: 'mfa@test.local' } });
      }
      if (String(url).endsWith('/user')) {
        return Response.json({ id: fixtures.userId, factors: enrolled
          ? [{ id: 'factor-1', status: 'verified', factor_type: 'totp' }] : [] });
      }
      throw new Error(`Unexpected provider request: ${String(url)}`);
    }));
    const signedIn = response();
    await login(request(), signedIn.res);
    expect(signedIn.state.statusCode).toBe(200);
    const cookies = signedIn.headers.get('set-cookie') as string[];
    const name = enrolled ? 'sb-pending-mfa' : 'sb-access-token';
    const issued = cookies.find((cookie) => cookie.startsWith(`${name}=`));
    expect(issued).toBeDefined();
    const issuedToken = issued!.split(';')[0]!.slice(name.length + 1);
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => res.status(200).json({ private: true }));
    const protectedResponse = response();
    await withAuth(handler)(request(`sb-access-token=${issuedToken}; active_company_id=${fixtures.companyId}`), protectedResponse.res);
    expect(protectedResponse.state.statusCode).toBe(enrolled ? 401 : 200);
    expect(handler).toHaveBeenCalledTimes(enrolled ? 0 : 1);
  });
});
