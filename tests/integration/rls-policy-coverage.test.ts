// tests/integration/rls-policy-coverage.test.ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

/**
 * company_id tables known to lack RLS, each a real defect awaiting its own fix
 * (not an exemption). Found when this suite first ran in the CI gate, 11 Nov 2026.
 */
const KNOWN_GAPS: Record<string, string> = {
  portal_access: 'KNOWN BUG: migration 937 added company_id but no RLS, FORCE RLS or policy; app_user keeps SELECT on it '
    + '(every column but password_hash) and DELETE, so tenant isolation of AR portal logins rests on query filters alone.',
};

describe('RLS policy coverage across every company_id table', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL, max: 2 }); });
  afterAll(async () => { await pool.end(); });

  it('every public table with company_id has rowsecurity + forcerowsecurity + a policy', async () => {
    const { rows } = await pool.query<{
      table_name: string; rowsecurity: boolean; forcerowsecurity: boolean; policy_count: number;
    }>(`
      WITH cid_tables AS (
        SELECT DISTINCT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tb USING (table_schema, table_name)
        WHERE c.column_name = 'company_id' AND c.table_schema = 'public'
          AND tb.table_type = 'BASE TABLE'
      )
      SELECT
        t.table_name,
        pc.relrowsecurity AS rowsecurity,
        pc.relforcerowsecurity AS forcerowsecurity,
        COALESCE(p.policy_count, 0) AS policy_count
      FROM cid_tables t
      JOIN pg_class pc ON pc.relname = t.table_name AND pc.relnamespace = 'public'::regnamespace
      LEFT JOIN (
        SELECT tablename, COUNT(*)::int AS policy_count FROM pg_policies
        WHERE schemaname = 'public' GROUP BY tablename
      ) p ON p.tablename = t.table_name
      ORDER BY t.table_name
    `);

    const gaps = rows.filter((r) => !r.rowsecurity || !r.forcerowsecurity || r.policy_count === 0);
    const broken = gaps.filter((r) => !(r.table_name in KNOWN_GAPS));
    if (broken.length > 0) {
      console.error('RLS coverage gaps:', broken);
    }
    expect(broken).toEqual([]);
    // A known gap that has been fixed must leave the list, so the list cannot rot into an allowlist.
    expect(Object.keys(KNOWN_GAPS).filter((t) => !gaps.some((g) => g.table_name === t)), 'fixed: remove from KNOWN_GAPS').toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(115); // sanity: 117 minus companies ± schema drift
  });
});
