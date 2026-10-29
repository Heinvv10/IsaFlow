/**
 * Migration 949: a LOCKED version's drivers and planned hires cannot be inserted, changed,
 * moved away or deleted (947's budget_month_amounts_refuse_locked, attached ENABLE ALWAYS), as
 * app_user and as the table owner; an amount's amount_source is frozen with it. A rolling
 * forecast row is NOT budget content: a roll that meets a locked version records last_error on
 * it (spec §6). Real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';
import { driverFixture } from './helpers/budgetDriverFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, setup, cleanup, version, lock, amount, asAppUser, codeOf } = budgetVersionFixture(pool);
const { driver, hire, rolling } = driverFixture();

let locked: string, open: string, driverId: string, hireId: string, amountId: string, rollId: string;

beforeAll(async () => {
  await setup();
  locked = await version(A, { status: 'approved', kind: 'reforecast' });
  driverId = (await driver(pool, A, locked)).rows[0].id;
  hireId = (await hire(pool, A, locked)).rows[0].id;
  amountId = (await amount(A, locked, { acct: A.acct2 })).rows[0].id;
  rollId = (await rolling(pool, A, locked)).rows[0].id;
  await lock(A, locked);
  open = await version(A);
});
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const writes = (v: string, sibling: string): [string, string, unknown[]][] => [
  ['driver insert', ...driver.sql(A, v, { acct: A.acct2 })],
  ['driver update', `UPDATE budget_driver_lines SET amount = 5 WHERE id = $1`, [driverId]],
  ['driver moved away', `UPDATE budget_driver_lines SET version_id = $2 WHERE id = $1`, [driverId, sibling]],
  ['driver delete', `DELETE FROM budget_driver_lines WHERE id = $1`, [driverId]],
  ['hire insert', ...hire.sql(A, v)],
  ['hire update', `UPDATE budget_planned_hires SET fte = 2 WHERE id = $1`, [hireId]],
  ['hire moved away', `UPDATE budget_planned_hires SET version_id = $2 WHERE id = $1`, [hireId, sibling]],
  ['hire delete', `DELETE FROM budget_planned_hires WHERE id = $1`, [hireId]],
  ['amount source', `UPDATE budget_month_amounts SET amount_source = 'override' WHERE id = $1`, [amountId]],
];

describe('949: a locked version refuses driver, hire and amount-source writes', () => {
  it('as app_user, every write is refused BV001', async () => {
    await asAppUser(A, async (q) => {
      for (const [what, text, params] of writes(locked, open)) expect(await codeOf(q, text, params), what).toBe('BV001');
    });
  });

  it('as the fixture owner (a superuser that bypasses RLS), the same writes are refused', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const [what, text, params] of writes(locked, open)) expect(await codeOf(c, text, params), what).toBe('BV001');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('under session_replication_role = replica the triggers still fire (ENABLE ALWAYS)', async (ctx) => {
    const su = (await pool.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0].rolsuper;
    if (!su) ctx.skip();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      for (const [what, text, params] of writes(locked, open)) expect(await codeOf(c, text, params), what).toBe('BV001');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it("an open version's drivers and hires stay writable, and a row cannot move INTO the locked one", async () => {
    await asAppUser(A, async (q) => {
      const d = (await driver(q, A, open)).rows[0].id as string;
      const h = (await hire(q, A, open)).rows[0].id as string;
      expect(await codeOf(q, `UPDATE budget_driver_lines SET amount = 7 WHERE id = $1`, [d])).toBe('ok');
      expect(await codeOf(q, `UPDATE budget_planned_hires SET fte = 0.5 WHERE id = $1`, [h])).toBe('ok');
      expect(await codeOf(q, `UPDATE budget_driver_lines SET version_id = $2 WHERE id = $1`, [d, locked])).toBe('BV001');
      expect(await codeOf(q, `UPDATE budget_planned_hires SET version_id = $2 WHERE id = $1`, [h, locked])).toBe('BV001');
      expect(await codeOf(q, `DELETE FROM budget_driver_lines WHERE id = $1`, [d])).toBe('ok');
      expect(await codeOf(q, `DELETE FROM budget_planned_hires WHERE id = $1`, [h])).toBe('ok');
    });
  });

  it("a locked version's rolling row still takes last_error (the roll records the skip)", async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, `UPDATE budget_rolling_forecasts SET last_error = 'version locked' WHERE id = $1`, [rollId])).toBe('ok');
    });
  });
});
