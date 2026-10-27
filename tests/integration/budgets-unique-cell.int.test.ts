/**
 * Migration 947: budget_month_amounts_one_per_cell is UNIQUE NULLS NOT DISTINCT, so two
 * company-level rows (all dimensions NULL) for one version, account and month collide (23505),
 * while the same cell in two versions does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, setup, cleanup, version, amount, asAppUser, codeOf } = budgetVersionFixture(pool);

beforeAll(setup);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const INS = `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
             VALUES ($1, $2, $3, '2026-06-01', 7, $4)`;

describe('947: one amount per cell', () => {
  it('a second company-level row for the same version, account and month is refused 23505', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q);
      expect(await codeOf(q, INS, [A.id, v, A.acct, null])).toBe('ok');
      expect(await codeOf(q, INS, [A.id, v, A.acct, null])).toBe('23505:budget_month_amounts_one_per_cell');
    });
  });

  it('a second row for the same CC1 cell is refused; another CC1 member is its own cell', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q);
      expect(await codeOf(q, INS, [A.id, v, A.acct, A.cc1])).toBe('ok');
      expect(await codeOf(q, INS, [A.id, v, A.acct, A.cc1])).toBe('23505:budget_month_amounts_one_per_cell');
      expect(await codeOf(q, INS, [A.id, v, A.acct, A.cc1b])).toBe('ok');
    });
  });

  it('the same cell in two versions is two rows', async () => {
    await asAppUser(A, async (q) => {
      const v1 = await version(A, {}, q), v2 = await version(A, {}, q);
      await amount(A, v1, { month: '2026-06-01' }, q);
      expect(await codeOf(q, INS, [A.id, v2, A.acct, null])).toBe('ok');
    });
  });
});
