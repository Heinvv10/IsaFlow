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
  return new SignJWT({ sub, aud: 'authenticated', role: 'authenticated' })
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
  let _status = 200;
  let _body: unknown;
  const res = {
    status(c: number) {
      _status = c;
      return this;
    },
    json(v: unknown) {
      _body = v;
      return this;
    },
    setHeader() {
      /* noop */
    },
    getHeader() {
      return undefined;
    },
  } as unknown as NextApiResponse;
  return {
    res,
    get status() {
      return _status;
    },
    get body() {
      return _body;
    },
  };
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

    expect(r.status).toBe(200);
    expect(seenRowCount).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
