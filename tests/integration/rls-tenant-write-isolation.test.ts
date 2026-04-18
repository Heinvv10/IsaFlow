// tests/integration/rls-tenant-write-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

describe('RLS tenant write isolation', () => {
  let admin: Pool;
  const CA = '00000000-0000-0000-0000-00000000caaa';
  const UA = 'phase2-iso-user-A';
  const CB = '00000000-0000-0000-0000-00000000cbbb'; // A is NOT a member of CB

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });
  afterAll(async () => { await admin.end(); });

  it('INSERT targeting a different company_id is rejected by WITH CHECK', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_user`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [CA]);

      await expect(
        client.query(
          `INSERT INTO public.customers (id, company_id, name) VALUES (gen_random_uuid(), $1::uuid, 'Evil')`,
          [CB]  // different from app.current_company_id
        )
      ).rejects.toThrow(/row-level security/i);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
