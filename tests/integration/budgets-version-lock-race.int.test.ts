/**
 * Migration 947: a lock and an amount write serialise on the version row (the trigger's FOR SHARE
 * against the status UPDATE's row lock). (a) A writer in flight holds the locker back until it
 * commits, so its row is in before the lock. (b) A lock in flight holds the writer back, which then
 * sees 'locked' and fails BV001. The waits are read from pg_stat_activity, not slept through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';
import { backendPid, outcome, waitUntilBlocked } from './helpers/lockWait';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const { A, setup, cleanup, version } = budgetVersionFixture(pool);

beforeAll(setup);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const INSERT = `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount) VALUES ($1, $2, $3, $4, 5)`;
const LOCK = `UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = now() WHERE id = $1`;

async function two<T>(fn: (a: PoolClient, b: PoolClient) => Promise<T>): Promise<T> {
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    return await fn(a, b);
  } finally {
    await a.query('ROLLBACK').catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    a.release();
    b.release();
  }
}

describe('947: lock vs write race', () => {
  it('(a) a writer in flight blocks the locker; the writer commits first and its row stays', async () => {
    const v = await version(A, { status: 'approved' });
    await two(async (a, b) => {
      await a.query(INSERT, [A.id, v, A.acct, '2026-03-01']);
      const pidB = await backendPid(b);
      const settled = outcome(b.query(LOCK, [v, A.user]));
      await waitUntilBlocked(pool, pidB);
      await a.query('COMMIT');
      expect(await settled).toBe('ok');
      await b.query('COMMIT');
    });
    const n = (await pool.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE version_id = $1', [v])).rows[0].n;
    expect(n).toBe(1);
    expect((await pool.query('SELECT status FROM budget_versions WHERE id = $1', [v])).rows[0].status).toBe('locked');
  });

  it('(b) a lock in flight blocks the writer, which fails BV001 once the lock commits', async () => {
    const v = await version(A, { status: 'approved' });
    await two(async (a, b) => {
      await b.query(LOCK, [v, A.user]);
      const pidA = await backendPid(a);
      const writing = outcome(a.query(INSERT, [A.id, v, A.acct, '2026-04-01']));
      await waitUntilBlocked(pool, pidA);
      await b.query('COMMIT');
      expect(await writing).toBe('BV001');
    });
    const n = (await pool.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE version_id = $1', [v])).rows[0].n;
    expect(n).toBe(0);
  });

  it('(b) with the lock rolled back instead, the blocked writer proceeds', async () => {
    const v = await version(A, { status: 'approved' });
    await two(async (a, b) => {
      await b.query(LOCK, [v, A.user]);
      const pidA = await backendPid(a);
      const writing = outcome(a.query(INSERT, [A.id, v, A.acct, '2026-05-01']));
      await waitUntilBlocked(pool, pidA);
      await b.query('ROLLBACK');
      expect(await writing).toBe('ok');
    });
  });
});
