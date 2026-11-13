/**
 * Migration 983: budget_three_way_assumptions (budgets P6). As app_user, opened exactly as withAuth
 * opens a session: a locked version refuses every write (I9, BV001); another company's rows are
 * invisible and unwritable and an A row cannot name B's version (I10); the stamps and the
 * concurrency token (updated_at) are the database's, never the writer's; one row per version;
 * the dark feature flag exists and is not global. Real PostgreSQL; synthetic rows only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, approve, lock, unlock, asAppUser, codeOf } = budgetVersionFixture(pool);

const T = 'budget_three_way_assumptions';
const DOC = JSON.stringify({ schemaVersion: 1, minimumCash: { value: 0, source: 'manual' } });
const insertSql = (company: string, versionId: string): [string, unknown[]] => [
  `INSERT INTO ${T} (company_id, version_id, doc) VALUES ($1, $2, $3::jsonb)`, [company, versionId, DOC]];

let aDraft: string, bDraft: string, bRow: string;

beforeAll(async () => {
  await setup();
  aDraft = await version(A, { name: 'P6 A draft' });
  bDraft = await version(B, { name: 'P6 B draft' });
  bRow = (await pool.query(`INSERT INTO ${T} (company_id, version_id, doc) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [B.id, bDraft, DOC])).rows[0].id;
});
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

describe('983: budget_three_way_assumptions', () => {
  it('forced RLS with the 944 policy', async () => {
    const r = (await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS qual
         FROM pg_class c WHERE c.oid = $1::regclass`, [T])).rows[0];
    expect([r.relrowsecurity, r.relforcerowsecurity]).toEqual([true, true]);
    expect(r.qual).toContain('app.current_company_id()');
    expect(r.qual).toContain('auth.user_companies()');
  });

  it("I10: A's session sees none of B's rows and changes none", async () => {
    await asAppUser(A, async (q) => {
      expect((await q.query(`SELECT COUNT(*)::int n FROM ${T} WHERE id = $1`, [bRow])).rows[0].n).toBe(0);
      expect((await q.query(`UPDATE ${T} SET doc = '{}'::jsonb WHERE id = $1`, [bRow])).rowCount).toBe(0);
      expect((await q.query(`DELETE FROM ${T} WHERE id = $1`, [bRow])).rowCount).toBe(0);
    });
    expect((await pool.query(`SELECT doc FROM ${T} WHERE id = $1`, [bRow])).rows[0].doc).toEqual(JSON.parse(DOC));
  });

  it("I10: A cannot insert B's company_id, nor an A row naming B's version", async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...insertSql(B.id, bDraft))).toMatch(/^(42501|23503)/);
      expect(await codeOf(q, ...insertSql(A.id, bDraft))).toMatch(/^23503/);
      expect(await codeOf(q, ...insertSql(A.id, aDraft))).toBe('ok');
    });
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM ${T} WHERE company_id = $1`, [B.id])).rows[0].n)).toBe(1);
  });

  it('I9: a locked version refuses INSERT, UPDATE and DELETE as app_user (BV001)', async () => {
    const v = await version(A, { name: 'P6 A locked' });
    await asAppUser(A, async (q) => { await q.query(...insertSql(A.id, v)); }, true);
    await approve(A, v);
    await lock(A, v);
    try {
      await asAppUser(A, async (q) => {
        expect(await codeOf(q, `UPDATE ${T} SET doc = '{}'::jsonb WHERE version_id = $1`, [v])).toBe('BV001');
        expect(await codeOf(q, `DELETE FROM ${T} WHERE version_id = $1`, [v])).toBe('BV001');
      });
      const v2 = await version(A, { name: 'P6 A locked empty', status: 'locked' });
      await asAppUser(A, async (q) => { expect(await codeOf(q, ...insertSql(A.id, v2))).toBe('BV001'); });
    } finally {
      await unlock(A, v, 'test');
    }
    expect((await pool.query(`SELECT doc FROM ${T} WHERE version_id = $1`, [v])).rows[0].doc).toEqual(JSON.parse(DOC));
  });

  it('one row per version', async () => {
    const v = await version(A, { name: 'P6 A unique' });
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...insertSql(A.id, v))).toBe('ok');
      expect(await codeOf(q, ...insertSql(A.id, v))).toBe('23505:budget_three_way_assumptions_version_uq');
    });
  });

  it('stamps are the database\'s: app_user cannot write id, stamps or the token, and the triggers set them', async () => {
    const v = await version(A, { name: 'P6 A stamps' });
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, `INSERT INTO ${T} (company_id, version_id, doc, updated_at) VALUES ($1, $2, '{}'::jsonb, '2000-01-01')`, [A.id, v])).toBe('42501');
      expect(await codeOf(q, `INSERT INTO ${T} (company_id, version_id, doc, updated_by) VALUES ($1, $2, '{}'::jsonb, 'forged')`, [A.id, v])).toBe('42501');
      expect(await codeOf(q, `INSERT INTO ${T} (id, company_id, version_id, doc) VALUES (gen_random_uuid(), $1, $2, '{}'::jsonb)`, [A.id, v])).toBe('42501');
      await q.query(...insertSql(A.id, v));
      const first = (await q.query(`SELECT updated_by, updated_at, created_at FROM ${T} WHERE version_id = $1`, [v])).rows[0];
      expect(first.updated_by).toBe(A.user);
      for (const col of ['updated_at', 'updated_by', 'created_at', 'company_id', 'version_id']) {
        expect(await codeOf(q, `UPDATE ${T} SET ${col} = ${col} WHERE version_id = $1`, [v]), col).toBe('42501');
      }
      await q.query(`UPDATE ${T} SET doc = '{"schemaVersion":1}'::jsonb WHERE version_id = $1`, [v]);
      const second = (await q.query(`SELECT updated_at, created_at FROM ${T} WHERE version_id = $1`, [v])).rows[0];
      expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
      expect(second.created_at.getTime()).toBe(first.created_at.getTime());
    });
  });

  it('refuses a non-object doc and an unknown schema_version', async () => {
    const v = await version(A, { name: 'P6 A checks' });
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, `INSERT INTO ${T} (company_id, version_id, doc) VALUES ($1, $2, '[]'::jsonb)`, [A.id, v])).toMatch(/^23514/);
      expect(await codeOf(q, `INSERT INTO ${T} (company_id, version_id, schema_version, doc) VALUES ($1, $2, 2, '{}'::jsonb)`, [A.id, v])).toMatch(/^23514/);
    });
  });

  it('deleting the version deletes its assumptions', async () => {
    const v = await version(A, { name: 'P6 A cascade' });
    await pool.query(...insertSql(A.id, v));
    await pool.query('DELETE FROM budget_versions WHERE id = $1', [v]);
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM ${T} WHERE version_id = $1`, [v])).rows[0].n)).toBe(0);
  });

  it('the budgets_three_way flag exists, dark', async () => {
    const r = await pool.query(`SELECT is_global FROM feature_flags WHERE code = 'budgets_three_way'`);
    expect(r.rows).toEqual([{ is_global: false }]);
  });
});
