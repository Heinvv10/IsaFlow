// tests/integration/withAuth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiResponse } from 'next';
import { Pool } from 'pg';
import { withAuth } from '@/lib/auth/withAuth';
import { sql } from '@/lib/neon';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL) throw new Error('JWT_SECRET + DATABASE_URL required');

const seedPool = new Pool({ connectionString: DATABASE_URL, max: 2 });

async function seed() {
  // Create a throwaway company + user + membership. Idempotent.
  await seedPool.query(`
    INSERT INTO companies (id, name, is_active)
    VALUES ('00000000-0000-0000-0000-000000000cc1', 'Phase2 WA Test Co', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await seedPool.query(`
    INSERT INTO users (id, email, role, is_active)
    VALUES ('phase2-wa-user-1', 'wa@phase2.test', 'admin', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await seedPool.query(`
    INSERT INTO company_users (company_id, user_id, role)
    VALUES ('00000000-0000-0000-0000-000000000cc1', 'phase2-wa-user-1', 'admin')
    ON CONFLICT DO NOTHING
  `);
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function mkReq(token: string, companyId: string) {
  return {
    headers: { cookie: `sb-access-token=${token}; active_company_id=${companyId}` },
    url: '/api/test',
  } as any;
}

function mkRes() {
  let status = 200;
  let body: unknown = undefined;
  const headers: Record<string, unknown> = {};
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; } };
}

beforeAll(async () => { await seed(); });
afterAll(async () => { await seedPool.end(); });

describe('withAuth — integration', () => {
  it('403s when cookie references a company the user is not a member of', async () => {
    const tok = await makeToken('phase2-wa-user-1');
    const r = mkRes();
    await withAuth(async () => { throw new Error('should not run'); })(
      mkReq(tok, '00000000-0000-0000-0000-000000000dead'),
      r.res
    );
    expect(r.status).toBe(403);
  });

  it('attaches user + companyId + runs handler inside tx with GUCs set', async () => {
    const tok = await makeToken('phase2-wa-user-1');
    const r = mkRes();
    let seen: { userId: string; companyId: string; cidGuc: string } | null = null;
    await withAuth(async (req: any, res: any) => {
      const rows = await sql<{ v: string }>`SELECT current_setting('app.current_company_id', true) AS v`;
      seen = { userId: req.user.id, companyId: req.companyId, cidGuc: rows[0]!.v };
      res.status(200).json({ ok: true });
    })(mkReq(tok, '00000000-0000-0000-0000-000000000cc1'), r.res);
    expect(r.status).toBe(200);
    expect(seen).not.toBeNull();
    expect(seen!.userId).toBe('phase2-wa-user-1');
    expect(seen!.companyId).toBe('00000000-0000-0000-0000-000000000cc1');
    expect(seen!.cidGuc).toBe('00000000-0000-0000-0000-000000000cc1');
  });
});
