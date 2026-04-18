// tests/integration/neon-als.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

describe('neon.ts — ALS-aware sql', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('uses the ALS-bound client when inside als.run', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [
        '00000000-0000-0000-0000-00000000abcd',
      ]);

      const seen = await als.run(
        { client, userId: 'probe', companyId: '00000000-0000-0000-0000-00000000abcd', claims: {} },
        async () => {
          const rows = await sql<{ v: string }>`SELECT current_setting('app.current_company_id', true) AS v`;
          return rows[0]!.v;
        }
      );

      expect(seen).toBe('00000000-0000-0000-0000-00000000abcd');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('falls through to the pool when no ALS context (scripts / cron)', async () => {
    const rows = await sql<{ one: number }>`SELECT 1 AS one`;
    expect(rows[0]!.one).toBe(1);
  });
});
