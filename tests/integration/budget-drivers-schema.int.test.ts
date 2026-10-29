/**
 * Migration 949's data rules: amount_source values; a driver's per-kind columns, month range
 * inside its version's year, and decision 4 (one grain per account per version) against the
 * amounts and among drivers; a rolling row names a reforecast of its own year. Real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';
import { driverFixture } from './helpers/budgetDriverFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, setup, cleanup, version, amount, asAppUser, codeOf } = budgetVersionFixture(pool);
const { driver, rolling } = driverFixture();

let v: string;

beforeAll(async () => {
  await setup();
  v = await version(A);
});
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

describe('949: budget_month_amounts.amount_source', () => {
  it("defaults to 'manual' and takes only manual / driver / override / actual", async () => {
    await asAppUser(A, async (q) => {
      const id = (await amount(A, v, {}, q)).rows[0].id as string;
      expect((await q.query('SELECT amount_source FROM budget_month_amounts WHERE id = $1', [id])).rows[0].amount_source).toBe('manual');
      for (const s of ['driver', 'override', 'actual', 'manual']) {
        expect(await codeOf(q, 'UPDATE budget_month_amounts SET amount_source = $2 WHERE id = $1', [id, s]), s).toBe('ok');
      }
      expect(await codeOf(q, "UPDATE budget_month_amounts SET amount_source = 'typed' WHERE id = $1", [id]))
        .toBe('23514:budget_month_amounts_amount_source_check');
    });
  });
});

describe('949: budget_driver_lines rules', () => {
  it('each kind is accepted with exactly its own columns', async () => {
    await asAppUser(A, async (q) => {
      for (const kind of ['fixed', 'pct_of_line', 'pct_of_section', 'growth', 'per_head'] as const) {
        expect(await codeOf(q, ...driver.sql(A, v, { kind })), kind).toBe('ok');
        await q.query('DELETE FROM budget_driver_lines WHERE version_id = $1', [v]);
      }
    });
  });

  it('a kind missing its column, or carrying another kind\'s, is refused', async () => {
    await asAppUser(A, async (q) => {
      const [text, params] = driver.sql(A, v, { kind: 'fixed' });
      expect(await codeOf(q, text, params.map((p, i) => (i === 9 ? null : p)))).toBe('23514:budget_driver_lines_kind_columns');
      expect(await codeOf(q, text, params.map((p, i) => (i === 10 ? 3 : p)))).toBe('23514:budget_driver_lines_kind_columns');
      // growth's base month must precede the range.
      expect(await codeOf(q, ...driver.sql(A, v, { kind: 'growth', base: '2026-05-01', from: '2026-04-01' })))
        .toBe('23514:budget_driver_lines_kind_columns');
      expect(await codeOf(q, ...driver.sql(A, v, { from: '2026-09-01', to: '2026-04-01' }))).toBe('23514:budget_driver_lines_range');
    });
  });

  it("months outside the version's registry year are refused", async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, v, { to: '2027-03-01' }))).toBe('23514');
      expect(await codeOf(q, ...driver.sql(A, v, { from: '2026-02-01' }))).toBe('23514');
      expect(await codeOf(q, ...driver.sql(A, v, { from: '2026-03-01', to: '2027-02-01' }))).toBe('ok');
    });
  });

  it('one driver per row; one grain per account among drivers', async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, v, { cc1: A.cc1 }))).toBe('ok');
      expect(await codeOf(q, ...driver.sql(A, v, { cc1: A.cc1 }))).toBe('23505:budget_driver_lines_one_per_row');
      expect(await codeOf(q, ...driver.sql(A, v, { cc1: A.cc1b }))).toBe('ok');
      expect(await codeOf(q, ...driver.sql(A, v, {}))).toBe('23P01:budget_driver_lines_one_grain');
      expect(await codeOf(q, ...driver.sql(A, v, { bu: A.bu }))).toBe('23P01:budget_driver_lines_one_grain');
    });
  });

  it("a driver at another grain than the version's amounts for that account is refused as the amounts' grain clash", async () => {
    await asAppUser(A, async (q) => {
      await amount(A, v, { acct: A.acct2, cc1: A.cc1 }, q);
      expect(await codeOf(q, ...driver.sql(A, v, { acct: A.acct2 }))).toBe('23P01:budget_month_amounts_one_grain');
      expect(await codeOf(q, ...driver.sql(A, v, { acct: A.acct2, cc1: A.cc1b }))).toBe('ok');
    });
  });

  it('a CC1 grain must name a CC1 centre (947 kinds check)', async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, v, { cc1: A.cc2 }))).toBe('23514');
    });
  });
});

describe('949: review round 1 rules', () => {
  it("an amount at another grain than the account's driver is refused as the amounts' grain clash", async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, v, { cc1: A.cc1 }))).toBe('ok');
      expect(await codeOf(q, `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
                              VALUES ($1, $2, $3, '2027-01-01', 5)`, [A.id, v, A.acct])).toBe('23P01:budget_month_amounts_one_grain');
      expect(await codeOf(q, `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, month, amount)
                              VALUES ($1, $2, $3, $4, '2027-01-01', 5)`, [A.id, v, A.acct, A.cc1b])).toBe('ok');
    });
  });

  it('a centre a driver uses (grain or reference) cannot change kind', async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, v, { cc1: A.cc1 }))).toBe('ok');
      expect(await codeOf(q, ...driver.sql(A, v, { acct: A.acct2, cc2: A.cc2, kind: 'pct_of_line', refAcct: A.acct, refCc1: A.cc1b }))).toBe('ok');
      expect(await codeOf(q, `UPDATE cost_centres SET cc_type = 'cc2' WHERE id = $1`, [A.cc1])).toBe('23514');
      expect(await codeOf(q, `UPDATE cost_centres SET cc_type = 'cc2' WHERE id = $1`, [A.cc1b])).toBe('23514');
      expect(await codeOf(q, `UPDATE cost_centres SET cc_type = 'cc1' WHERE id = $1`, [A.cc2])).toBe('23514');
    });
  });

  it("a reference's CC1/CC2 must be of that kind", async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, v, { kind: 'pct_of_line', refCc1: A.cc2 }))).toBe('23514');
      expect(await codeOf(q, ...driver.sql(A, v, { kind: 'pct_of_line', refCc2: A.cc1 }))).toBe('23514');
      expect(await codeOf(q, ...driver.sql(A, v, { kind: 'pct_of_line', refCc1: A.cc1 }))).toBe('ok');
    });
  });

  it('a row cannot be a % of itself', async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, v, { kind: 'pct_of_line', refAcct: A.acct }))).toBe('23514:budget_driver_lines_not_self');
      expect(await codeOf(q, ...driver.sql(A, v, { kind: 'pct_of_line', cc1: A.cc1, refAcct: A.acct, refCc1: A.cc1 })))
        .toBe('23514:budget_driver_lines_not_self');
    });
  });

  it("deleting a referenced account is refused, never cascading into another account's driver", async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await driver(c, A, v, { kind: 'pct_of_line', refAcct: A.acct2 });
      expect(await codeOf(c, 'DELETE FROM gl_accounts WHERE id = $1', [A.acct2])).toMatch(/^23503/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('app_user cannot rewrite id, company or creation stamps', async () => {
    await asAppUser(A, async (q) => {
      const d = (await driver(q, A, v)).rows[0].id as string;
      for (const col of ['created_by', 'created_at', 'company_id', 'id']) {
        const val = col === 'created_at' ? 'now()' : col === 'created_by' ? `'forged'` : 'gen_random_uuid()';
        expect(await codeOf(q, `UPDATE budget_driver_lines SET ${col} = ${val} WHERE id = $1`, [d]), col).toBe('42501');
      }
      expect(await codeOf(q, `UPDATE budget_driver_lines SET amount = 3, updated_by = 'me' WHERE id = $1`, [d])).toBe('ok');
    });
  });
});

describe('949: budget_rolling_forecasts rules', () => {
  it('names a reforecast of its own year, once per company-year and once per version', async () => {
    const reforecast = await version(A, { kind: 'reforecast' });
    const other = await version(A, { kind: 'reforecast' });
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...rolling.sql(A, v))).toBe('23514');
      expect(await codeOf(q, ...rolling.sql(A, reforecast, { fy: 2028 }))).toBe('23514');
      expect(await codeOf(q, ...rolling.sql(A, reforecast))).toBe('ok');
      expect(await codeOf(q, ...rolling.sql(A, other))).toBe('23505:budget_rolling_forecasts_one_per_year');
    });
  });
});
