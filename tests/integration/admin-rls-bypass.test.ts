// tests/integration/admin-rls-bypass.test.ts
// Proves BYPASSRLS is actually engaged for withPlatformAdmin:
// - Seeds 2 companies + 1 customer each + 1 invoice each.
// - Seeds a super_admin user.
// - Runs withPlatformAdmin → handler counts customer_invoices across all
//   companies (WHERE invoice_number LIKE 'PA-TEST-%').
// - Expects count >= 2 (cross-tenant visible). Under plain RLS a
//   single-company membership would see at most 1.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiResponse } from 'next';
import { Pool } from 'pg';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';
import { sql } from '@/lib/neon';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL) throw new Error('JWT_SECRET + DATABASE_URL required');

const seedPool = new Pool({ connectionString: DATABASE_URL, max: 2 });

const USER_ID = 'plat-admin-test-user';
const CO_A = '00000000-0000-0000-0000-000000000aa1';
const CO_B = '00000000-0000-0000-0000-000000000aa2';
const CUST_A = '00000000-0000-0000-0000-000000000ca1';
const CUST_B = '00000000-0000-0000-0000-000000000ca2';

async function seed() {
  await seedPool.query(
    `INSERT INTO companies (id, name, is_active) VALUES
       ($1, 'Platform Admin Test A', true),
       ($2, 'Platform Admin Test B', true)
     ON CONFLICT (id) DO NOTHING`,
    [CO_A, CO_B]
  );

  // customers.id is UUID; name + company_id are the only NOT NULL columns.
  await seedPool.query(
    `INSERT INTO customers (id, name, company_id) VALUES
       ($1, 'PA Test Customer A', $3),
       ($2, 'PA Test Customer B', $4)
     ON CONFLICT (id) DO NOTHING`,
    [CUST_A, CUST_B, CO_A, CO_B]
  );

  await seedPool.query(
    `INSERT INTO users (id, email, role, is_active) VALUES
       ($1, 'plat-admin@test.local', 'super_admin', true)
     ON CONFLICT (id) DO UPDATE SET role = 'super_admin'`,
    [USER_ID]
  );

  // invoice_number has no UNIQUE constraint — use bare ON CONFLICT DO NOTHING
  // (not ON CONFLICT (column)) to avoid "there is no unique or exclusion
  // constraint matching the ON CONFLICT specification" error.
  await seedPool.query(
    `INSERT INTO customer_invoices
       (company_id, customer_id, invoice_number, total_amount, created_by)
     SELECT * FROM (VALUES
       ($1::uuid, $3::uuid, 'PA-TEST-A-1', 100::numeric, 'seed'),
       ($2::uuid, $4::uuid, 'PA-TEST-B-1', 100::numeric, 'seed')
     ) AS v(company_id, customer_id, invoice_number, total_amount, created_by)
     WHERE NOT EXISTS (
       SELECT 1 FROM customer_invoices ci
       WHERE ci.invoice_number = v.invoice_number
         AND ci.company_id = v.company_id
     )`,
    [CO_A, CO_B, CUST_A, CUST_B]
  );
}

async function makeToken(sub: string) {
  // aal2: a completed session, so verifyToken settles it from the signature
  // alone. An AAL1 token makes it ask GoTrue for the user's factors, which
  // this suite has nothing to do with (and the CI gate runs no GoTrue).
  return new SignJWT({ sub, aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function mkReq(token: string) {
  return {
    headers: { cookie: `sb-access-token=${token}` },
    url: '/api/admin/test',
  } as never;
}

function mkRes() {
  const state = { status: 200, body: undefined as unknown, finished: false, headersSent: false };
  const headers: Record<string, unknown> = {};
  // Mirrors Next's api-resolver (as withAuth.test.ts does): json/send funnel
  // through end, and headersSent flips only once end flushes, so the wrapper's
  // deferred flush (deferEnd, which rebinds res.end) runs as it does in a request.
  const res: Record<string, unknown> = {
    get statusCode() { return state.status; },
    set statusCode(c: number) { state.status = c; },
    get headersSent() { return state.headersSent; },
    get finished() { return state.finished; },
    status(c: number) { state.status = c; return res; },
    json(v: unknown) { state.body = v; return (res.send as (b: unknown) => unknown)(JSON.stringify(v)); },
    send(v: unknown) { state.body = v; return (res.end as (b?: unknown) => unknown)(v); },
    end(v?: unknown) {
      if (state.finished) return res;
      state.finished = true;
      state.headersSent = true;
      if (v !== undefined) state.body = v;
      return res;
    },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
  };
  return { res: res as unknown as NextApiResponse, get status() { return state.status; }, get body() { return state.body; } };
}

describe('withPlatformAdmin — RLS bypass proof', () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    await seedPool.end();
  });

  it('sees invoices from multiple tenants (BYPASSRLS engaged)', async () => {
    const tok = await makeToken(USER_ID);
    const r = mkRes();
    let seenRowCount = 0;

    await withPlatformAdmin(async (_req: unknown, res: NextApiResponse) => {
      // sql routes through the ALS-bound platform_admin client (BYPASSRLS).
      // A plain app_user client would be blocked by the tenant_isolation RLS
      // policy and return 0 rows (no company membership for our test user).
      const rows = await sql`
        SELECT COUNT(*)::int AS n
        FROM customer_invoices
        WHERE invoice_number LIKE 'PA-TEST-%'
      `;
      seenRowCount = (rows[0] as { n: number }).n;
      res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(seenRowCount).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
