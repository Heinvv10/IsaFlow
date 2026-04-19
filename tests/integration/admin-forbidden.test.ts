// tests/integration/admin-forbidden.test.ts
// A non-super-admin user must be rejected by withPlatformAdmin (403).
// The handler must never run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiResponse } from 'next';
import { Pool } from 'pg';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL) throw new Error('JWT_SECRET + DATABASE_URL required');

const seedPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const USER_ID = 'tenant-only-test-user';

async function seed() {
  await seedPool.query(`
    INSERT INTO users (id, email, role, is_active) VALUES
      ($1, 'tenant-only@test.local', 'manager', true)
    ON CONFLICT (id) DO UPDATE SET role = 'manager'
  `, [USER_ID]);
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function mkReq(token: string) {
  return { headers: { cookie: `sb-access-token=${token}` }, url: '/api/admin/test' } as never;
}

function mkRes() {
  let status = 200;
  let body: unknown;
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader() { /* noop */ },
    getHeader() { return undefined; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; } };
}

describe('withPlatformAdmin — tenant user forbidden', () => {
  beforeAll(async () => { await seed(); });
  afterAll(async () => { await seedPool.end(); });

  it('returns 403 NOT_SUPER_ADMIN and does not invoke handler', async () => {
    const tok = await makeToken(USER_ID);
    const r = mkRes();
    let ran = false;
    await withPlatformAdmin(async (_req: unknown, _res: NextApiResponse) => { ran = true; })(mkReq(tok), r.res);
    expect(r.status).toBe(403);
    expect(ran).toBe(false);
    expect(r.body).toMatchObject({
      success: false,
      error: { code: 'NOT_SUPER_ADMIN' },
    });
  });
});
