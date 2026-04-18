// tests/integration/rls-pool-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required for integration tests');

describe('RLS pool isolation', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 }); // size 1 forces reuse
  });

  afterAll(async () => {
    await pool.end();
  });

  it('set_config(..., true) does not leak across pooled connections', async () => {
    // Run 20 interleaved "requests" alternating between two users.
    // Each wraps its work in a tx, sets GUCs, reads them back, commits.
    const runRequest = async (userId: string, companyId: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify({ sub: userId })]
        );
        await client.query(
          `SELECT set_config('app.current_company_id', $1, true)`,
          [companyId]
        );
        const { rows } = await client.query(
          `SELECT current_setting('request.jwt.claims', true) AS claims,
                  current_setting('app.current_company_id', true) AS cid`
        );
        await client.query('COMMIT');
        return { claims: rows[0].claims, cid: rows[0].cid };
      } finally {
        client.release();
      }
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const userId = i % 2 === 0 ? 'user-A' : 'user-B';
        const companyId =
          i % 2 === 0
            ? '00000000-0000-0000-0000-00000000000a'
            : '00000000-0000-0000-0000-00000000000b';
        return runRequest(userId, companyId).then((r) => ({
          userId,
          companyId,
          ...r,
        }));
      })
    );

    for (const r of results) {
      const parsed = JSON.parse(r.claims);
      expect(parsed.sub).toBe(r.userId);
      expect(r.cid).toBe(r.companyId);
    }

    // Verify the GUCs do NOT persist after COMMIT — one extra query outside any tx
    const probe = await pool.query(
      `SELECT current_setting('app.current_company_id', true) AS cid`
    );
    expect(probe.rows[0].cid).toBe('');
  });
});
