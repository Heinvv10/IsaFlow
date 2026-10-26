/**
 * Migration 947: a LOCKED version's amounts cannot be inserted, changed, moved away or deleted
 * (budget_month_amounts_refuse_locked, BV001), as app_user and as the table owner, and the
 * trigger fires under session_replication_role = replica (ENABLE ALWAYS). A locked version
 * cannot be deleted; a draft's delete cascades to its amounts. Real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, amount, asAppUser, codeOf } = budgetVersionFixture(pool);

let locked: string, open: string, rowId: string, openRow: string;

beforeAll(async () => {
  await setup();
  locked = await version(A, { status: 'approved' });
  rowId = (await amount(A, locked)).rows[0].id;
  await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = now() WHERE id = $1`, [locked, A.user]);
  open = await version(A);
  openRow = (await amount(A, open)).rows[0].id;
});
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const writes = (v: string, row: string, sibling: string) => [
  ['insert', `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
              VALUES ($1, '${v}', $2, '2026-04-01', 1)`],
  ['update amount', `UPDATE budget_month_amounts SET amount = 999 WHERE id = '${row}'`],
  ['move to another version', `UPDATE budget_month_amounts SET version_id = '${sibling}' WHERE id = '${row}'`],
  ['delete', `DELETE FROM budget_month_amounts WHERE id = '${row}'`],
] as const;

describe('947: a locked version is immutable', () => {
  it('as app_user, INSERT, UPDATE, a version move and DELETE are each refused BV001', async () => {
    await asAppUser(A, async (q) => {
      for (const [what, text] of writes(locked, rowId, open)) {
        const params = text.includes('$1') ? [A.id, A.acct] : [];
        expect(await codeOf(q, text, params), what).toBe('BV001');
      }
      // Moving an open version's row INTO the locked one is refused on the NEW side.
      expect(await codeOf(q, `UPDATE budget_month_amounts SET version_id = $1 WHERE id = $2`, [locked, openRow])).toBe('BV001');
    });
  });

  it('as the table owner, the same writes are refused', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const [what, text] of writes(locked, rowId, open)) {
        const params = text.includes('$1') ? [A.id, A.acct] : [];
        expect(await codeOf(c, text, params), what).toBe('BV001');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('under session_replication_role = replica (superuser only) the trigger still fires: ENABLE ALWAYS', async (ctx) => {
    const su = (await pool.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0].rolsuper;
    if (!su) ctx.skip();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      expect(await codeOf(c, `DELETE FROM budget_month_amounts WHERE id = $1`, [rowId])).toBe('BV001');
      expect(await codeOf(c, `UPDATE budget_month_amounts SET amount = 1 WHERE id = $1`, [rowId])).toBe('BV001');
      expect(await codeOf(c, `DELETE FROM budget_versions WHERE id = $1`, [locked])).toBe('BV001');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('a sibling version that is not locked stays writable', async () => {
    await asAppUser(A, async (q) => {
      for (const [what, text] of writes(open, openRow, open)) {
        const params = text.includes('$1') ? [A.id, A.acct] : [];
        expect(await codeOf(q, text, params), what).toBe('ok');
      }
    });
  });

  it('a version the session cannot see is never taken as unlocked: 23503, not a pass', async () => {
    // B's version, named from A's session with A's company on the row: the trigger (and FK) refuse.
    const bVersion = await version(B);
    await asAppUser(A, async (q) => {
      expect(await codeOf(q,
        `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount) VALUES ($1, $2, $3, '2026-05-01', 1)`,
        [A.id, bVersion, A.acct])).toBe('23503');
    });
  });

  it('a locked version cannot be deleted; a draft version delete cascades to its amounts', async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, `DELETE FROM budget_versions WHERE id = $1`, [locked])).toBe('BV001');
      const draft = await version(A, {}, q);
      await amount(A, draft, { acct: A.acct2 }, q);
      expect(await codeOf(q, `DELETE FROM budget_versions WHERE id = $1`, [draft])).toBe('ok');
      expect((await q.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE version_id = $1', [draft])).rows[0].n).toBe(0);
    });
  });
});
