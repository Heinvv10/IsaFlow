/**
 * Migration 947: an amount's version, CC1, CC2 and BU, and a version's based-on, all belong to the
 * row's company (composite foreign keys, 23503); CC1/CC2 carry the matching cc_type (23514); an
 * amount carries at most one dimension (decision 14, 23514). As app_user and as the owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, asAppUser, codeOf } = budgetVersionFixture(pool);

let vA: string, vB: string;
beforeAll(async () => {
  await setup();
  vA = await version(A);
  vB = await version(B);
});
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const INS = `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id)
             VALUES ($1, $2, $3, '2026-03-01', 1, $4, $5, $6)`;

async function asOwner<T>(fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

for (const [who, run] of [['app_user', (fn: (q: PoolClient) => Promise<void>) => asAppUser(A, fn)], ['owner', asOwner]] as const) {
  describe(`947 company consistency, as ${who}`, () => {
    it("another company's version, CC1, CC2 or BU is refused 23503", async () => {
      await run(async (q) => {
        expect(await codeOf(q, INS, [A.id, vB, A.acct, null, null, null]), 'version').toMatch(/^23503/);
        expect(await codeOf(q, INS, [A.id, vA, A.acct, B.cc1, null, null]), 'cc1').toMatch(/^23503/);
        expect(await codeOf(q, INS, [A.id, vA, A.acct, null, B.cc2, null]), 'cc2').toMatch(/^23503/);
        expect(await codeOf(q, INS, [A.id, vA, A.acct, null, null, B.bu]), 'bu').toMatch(/^23503/);
        expect(await codeOf(q, INS, [A.id, vA, A.acct, A.cc1, null, null]), 'own cc1').toBe('ok');
      });
    });

    it("a CC2 centre in cc1_id, or a CC1 centre in cc2_id, is refused 23514", async () => {
      await run(async (q) => {
        expect(await codeOf(q, INS, [A.id, vA, A.acct, A.cc2, null, null])).toBe('23514');
        expect(await codeOf(q, INS, [A.id, vA, A.acct2, null, A.cc1, null])).toBe('23514');
      });
    });

    it('an amount with two dimensions is refused (decision 14)', async () => {
      await run(async (q) => {
        expect(await codeOf(q, INS, [A.id, vA, A.acct, A.cc1, null, A.bu])).toBe('23514:budget_month_amounts_one_dimension');
      });
    });

    it("a version based on another company's version is refused 23503", async () => {
      await run(async (q) => {
        expect(await codeOf(q,
          `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, based_on_version_id, created_by)
           VALUES ($1, 2027, $2, 'scenario', $3, $4)`, [A.id, `based-${crypto.randomUUID()}`, vB, A.user])).toMatch(/^23503/);
      });
    });
  });
}

describe('947 company consistency holds after the write (composite keys, not only the trigger)', () => {
  it("a CC1, CC2 or BU that A's budget uses cannot be re-homed to company B: 23503", async () => {
    await asOwner(async (q) => {
      await q.query(INS, [A.id, vA, A.acct, A.cc1, null, null]);
      await q.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc2_id)
                     VALUES ($1, $2, $3, '2026-04-01', 1, $4)`, [A.id, vA, A.acct2, A.cc2]);
      const v2 = await version(A, {}, q);
      await q.query(INS, [A.id, v2, A.acct, null, null, A.bu]);
      expect(await codeOf(q, `UPDATE cost_centres SET company_id = $2, code = code || '-X' WHERE id = $1`, [A.cc1, B.id])).toMatch(/^23503/);
      expect(await codeOf(q, `UPDATE cost_centres SET company_id = $2, code = code || '-X' WHERE id = $1`, [A.cc2, B.id])).toMatch(/^23503/);
      expect(await codeOf(q, `UPDATE business_units SET company_id = $2, code = code || '-X' WHERE id = $1`, [A.bu, B.id])).toMatch(/^23503/);
    });
  });
});
