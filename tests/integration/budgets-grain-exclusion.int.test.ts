/**
 * Migration 947, decision 4: within one version an account is budgeted at ONE grain (company level,
 * or by CC1, CC2 or BU), by the exclusion constraint budget_month_amounts_one_grain (23P01). Members
 * of one grain coexist; another version is free; deleting a grain frees the account in the same
 * transaction; two concurrent writers of different grains serialise (the second waits, then fails
 * if the first committed, or proceeds if it rolled back).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';
import { backendPid, outcome, waitUntilBlocked } from './helpers/lockWait';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const { A, setup, cleanup, version, amount, asAppUser, codeOf } = budgetVersionFixture(pool);

beforeAll(setup);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const INS = `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id)
             VALUES ($1, $2, $3, $4, 1, $5, $6, $7)`;
const GRAIN = '23P01:budget_month_amounts_one_grain';

describe('947: one grain per account per version', () => {
  it('a CC1 row beside a company-level row of the same version and account is refused 23P01', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q);
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-03-01', null, null, null])).toBe('ok');
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-04-01', A.cc1, null, null])).toBe(GRAIN);
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-04-01', null, A.cc2, null]), 'cc2').toBe(GRAIN);
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-04-01', null, null, A.bu]), 'bu').toBe(GRAIN);
    });
  });

  it('BU rows and CC1 rows of one account collide too (every dimension counts in the grain)', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q);
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-03-01', null, null, A.bu])).toBe('ok');
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-03-01', A.cc1, null, null])).toBe(GRAIN);
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-03-01', null, A.cc2, null])).toBe(GRAIN);
    });
  });

  it('two CC1 members coexist; another account and another version are free', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q), w = await version(A, {}, q);
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-03-01', A.cc1, null, null])).toBe('ok');
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-03-01', A.cc1b, null, null])).toBe('ok');
      expect(await codeOf(q, INS, [A.id, v, A.acct2, '2026-03-01', null, null, null])).toBe('ok');
      expect(await codeOf(q, INS, [A.id, w, A.acct, '2026-03-01', null, null, null])).toBe('ok');
    });
  });

  it('deleting every row of a grain frees the account for another grain in the same transaction', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q);
      await amount(A, v, { month: '2026-03-01' }, q);
      await amount(A, v, { month: '2026-04-01' }, q);
      await q.query('DELETE FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2', [v, A.acct]);
      expect(await codeOf(q, INS, [A.id, v, A.acct, '2026-03-01', A.cc1, null, null])).toBe('ok');
    });
  });

  async function race(commitFirst: boolean): Promise<string> {
    const v = await version(A);
    const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(INS, [A.id, v, A.acct, '2026-03-01', null, null, null]);
      const pidB = await backendPid(b);
      const second = outcome(b.query(INS, [A.id, v, A.acct, '2026-03-01', A.cc1, null, null]));
      await waitUntilBlocked(pool, pidB);
      await a.query(commitFirst ? 'COMMIT' : 'ROLLBACK');
      return await second;
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }

  it('race: a concurrent writer of another grain waits, then fails 23P01 when the first commits', async () => {
    expect(await race(true)).toBe(GRAIN);
  });

  it('race: ... and proceeds when the first rolls back', async () => {
    expect(await race(false)).toBe('ok');
  });
});
