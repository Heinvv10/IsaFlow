// tests/unit/auth/withPlatformAdmin.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);

async function makeToken(sub: string) {
  return new SignJWT({ sub, email: 'x@y.z', aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkReq(token?: string): NextApiRequest {
  return {
    headers: { cookie: token ? `sb-access-token=${token}` : '' },
    url: '/api/admin/test',
  } as unknown as NextApiRequest;
}

function mkRes() {
  const headers: Record<string, unknown> = {};
  let status = 200;
  const body: { value?: unknown } = {};
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body.value = v; return this; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body.value; } };
}

interface FakeClient {
  queries: Array<{ text: string; values: unknown[] }>;
  released: boolean;
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
}

function makeFakeClient(roleRow: string | null, shouldError = false): FakeClient {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let released = false;
  return {
    queries,
    get released() { return released; },
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      // Matched on the table, not the column list: the gate query now also
      // selects the account-standing columns, and a text-exact mock would have
      // silently stopped matching.
      if (shouldError && /FROM users/i.test(text)) {
        throw new Error('simulated DB failure');
      }
      if (/FROM users/i.test(text)) {
        // Standing columns describe an active account — suspension cases live
        // in tests/unit/auth/suspendedIdentityPaths.test.ts.
        return {
          rows: roleRow
            ? [{ role: roleRow, is_active: true, status: 'active', suspended_at: null }]
            : [],
        };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
}

describe('withPlatformAdmin', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.DATABASE_URL = 'postgresql://postgres@localhost/ignored';
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://platform_admin@localhost/ignored';
  });

  afterEach(() => vi.resetAllMocks());

  it('401s when no sb-access-token cookie', async () => {
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const r = mkRes();
    await withPlatformAdmin(async () => { throw new Error('should not run'); })(mkReq(), r.res);
    expect(r.status).toBe(401);
  });

  it('401s on invalid token and clears auth cookies', async () => {
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const r = mkRes();
    await withPlatformAdmin(async () => { throw new Error('should not run'); })(mkReq('bogus'), r.res);
    expect(r.status).toBe(401);
    const sc = r.res.getHeader('set-cookie') as string[];
    expect(sc.some((c) => c.startsWith('sb-access-token=;'))).toBe(true);
  });

  it('403s when users.role !== super_admin', async () => {
    const appClient = makeFakeClient('viewer');
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let ran = false;
    await withPlatformAdmin(async () => { ran = true; })(mkReq(tok), r.res);
    expect(r.status).toBe(403);
    expect(ran).toBe(false);
    expect(adminClient.queries).toHaveLength(0);
    expect(r.res.getHeader('set-cookie')).toBeUndefined();
  });

  it('calls handler with req.user populated on super_admin', async () => {
    const appClient = makeFakeClient('super_admin');
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let seenId = '';
    await withPlatformAdmin(async (req: { user: { id: string } }) => {
      seenId = req.user.id;
      r.res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);
    expect(seenId).toBe('user-1');
    expect(r.status).toBe(200);
    const texts = adminClient.queries.map((q) => q.text.trim()).join('|');
    expect(texts).toContain('BEGIN');
    expect(texts).toContain('COMMIT');
    expect(adminClient.released).toBe(true);
  });

  it('returns 500 (fail-closed) when role-lookup query errors', async () => {
    const appClient = makeFakeClient('super_admin', true);
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let ran = false;
    await expect(
      withPlatformAdmin(async () => { ran = true; })(mkReq(tok), r.res)
    ).rejects.toThrow(/simulated DB failure/);
    expect(ran).toBe(false);
    expect(adminClient.queries).toHaveLength(0);
  });

  it('binds the admin client into ALS so sql`...` routes through it', async () => {
    const appClient = makeFakeClient('super_admin');
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { als } = await import('@/lib/als');
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let seenClient: unknown = null;
    await withPlatformAdmin(async () => {
      seenClient = als.getStore()?.client;
      r.res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);
    expect(seenClient).toBe(adminClient);
  });
});
