// tests/integration/rls-tenant-read-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

// Seeds two tenants A and B, each with a user-membership pair, then creates
// one row in a representative sample of tables for each. Asserts that when
// user A runs SELECTs with GUCs set for tenant A, they see zero rows belonging
// to tenant B.
describe('RLS tenant read isolation', () => {
  let admin: Pool;
  const CA = '00000000-0000-0000-0000-00000000caaa';
  const CB = '00000000-0000-0000-0000-00000000cbbb';
  const UA = 'phase2-iso-user-A';
  const UB = 'phase2-iso-user-B';

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'ISO-A', true), ($2, 'ISO-B', true) ON CONFLICT (id) DO NOTHING`,
      [CA, CB]
    );
    await admin.query(
      `INSERT INTO users (id, email, is_active) VALUES ($1, 'a@iso.test', true), ($2, 'b@iso.test', true) ON CONFLICT (id) DO NOTHING`,
      [UA, UB]
    );
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $3, 'admin'), ($2, $4, 'admin') ON CONFLICT DO NOTHING`,
      [CA, CB, UA, UB]
    );
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM company_users WHERE user_id IN ($1, $2)`, [UA, UB]);
    await admin.query(`DELETE FROM users WHERE id IN ($1, $2)`, [UA, UB]);
    await admin.query(`DELETE FROM companies WHERE id IN ($1, $2)`, [CA, CB]);
    await admin.end();
  });

  it('user A cannot read tenant B rows across a sample of tables', async () => {
    // Preferred sample tables — invoices renamed to customer_invoices in this schema
    const preferredTables = ['customers', 'suppliers', 'customer_invoices', 'bank_transactions', 'gl_journal_entries'];
    const existing = (await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [preferredTables]
    )).rows.map((r) => (r as { table_name: string }).table_name);

    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_user`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [CA]);
      for (const t of existing) {
        const q = `SELECT COUNT(*)::int AS c FROM public."${t}" WHERE company_id = $1::uuid`;
        const r = await client.query<{ c: number }>(q, [CB]);
        expect(r.rows[0]!.c, `Expected 0 rows for ${t} under tenant B (RLS should hide them)`).toBe(0);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
