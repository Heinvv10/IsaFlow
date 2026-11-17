/**
 * Migration 999i on payroll_company_settings (999a's table) as app_user: the salary pay day is NULL until a
 * company chooses one (a pre-existing 999a row is "not chosen", never a silent 25); rule and day are NULL
 * together or consistent; updated_by / updated_at are the stamp trigger's (app_user cannot send them, a
 * privileged forger is overwritten, no session user is refused). Real PostgreSQL; synthetic rows.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cash13SchemaFixture, codeOf } from './helpers/cash13SchemaFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setUp, tearDown, as } = cash13SchemaFixture(pool);
const INS = 'INSERT INTO payroll_company_settings (company_id, salary_pay_rule, salary_pay_day) VALUES ($1, $2, $3)';

beforeAll(async () => { await setUp(); }, 60_000);
afterAll(async () => {
  try { await tearDown(); } finally { await pool.end(); }
});

describe('999i: salary pay day columns', () => {
  it('a 999a-style row (pay week only) has no pay day chosen: both NULL', async () => {
    await as(A, async (q) => {
      const r = (await q.query(
        'INSERT INTO payroll_company_settings (company_id, pay_weekday) VALUES ($1, 4) RETURNING salary_pay_rule, salary_pay_day', [A.id])).rows[0];
      expect(r).toEqual({ salary_pay_rule: null, salary_pay_day: null });
    });
  });

  it.each([
    ['day_of_month 1', 'day_of_month', 1], ['day_of_month 31', 'day_of_month', 31],
    ['last_working_day with a kept day', 'last_working_day', 28], ['last_working_day, no day ever chosen', 'last_working_day', null],
  ])('accepts %s', async (_n, rule, day) => {
    await as(A, async (q) => { expect(await codeOf(q, INS, [A.id, rule, day])).toBe('ok'); });
  });

  it.each([
    ['day 0', 'day_of_month', 0, '23514:payroll_company_settings_salary_pay_day_check'],
    ['day 32', 'day_of_month', 32, '23514:payroll_company_settings_salary_pay_day_check'],
    ['an unknown rule', 'first_friday', 5, '23514:payroll_company_settings_salary_pay_rule_check'],
    ['day_of_month with no day', 'day_of_month', null, '23514:payroll_company_settings_salary_pay_shape'],
    ['a day with no rule', null, 25, '23514:payroll_company_settings_salary_pay_shape'],
  ])('refuses %s', async (_n, rule, day, code) => {
    await as(A, async (q) => { expect(await codeOf(q, INS, [A.id, rule, day])).toBe(code); });
  });
});

describe('999i: payroll_company_settings stamps', () => {
  it('app_user cannot send updated_by or updated_at', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, 'INSERT INTO payroll_company_settings (company_id, updated_by) VALUES ($1, $2)', [A.id, 'forged'])).toBe('42501');
      await q.query(INS, [A.id, 'day_of_month', 25]);
      expect(await codeOf(q, "UPDATE payroll_company_settings SET updated_by = 'forged' WHERE company_id = $1", [A.id])).toBe('42501');
      expect(await codeOf(q, "UPDATE payroll_company_settings SET updated_at = '2020-01-01' WHERE company_id = $1", [A.id])).toBe('42501');
    });
  });

  it('the trigger stamps the session user on insert and on update', async () => {
    await as(A, async (q) => {
      expect((await q.query(`${INS} RETURNING updated_by`, [A.id, 'day_of_month', 25])).rows[0].updated_by).toBe(A.user);
      await q.query('RESET ROLE');
      await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: B.user })]);
      const r = (await q.query(
        "UPDATE payroll_company_settings SET salary_pay_day = 26, updated_by = 'forged', updated_at = '2020-01-01' WHERE company_id = $1 RETURNING updated_by, updated_at",
        [A.id])).rows[0];
      expect(r.updated_by).toBe(B.user);
      expect(new Date(r.updated_at).getUTCFullYear()).toBeGreaterThan(2020);
    });
  });

  it('a privileged insert forging updated_by is overwritten', async () => {
    await as(A, async (q) => {
      await q.query('RESET ROLE');
      const r = (await q.query(
        "INSERT INTO payroll_company_settings (company_id, updated_by, updated_at) VALUES ($1, 'forged', '2020-01-01') RETURNING updated_by, updated_at", [A.id])).rows[0];
      expect(r.updated_by).toBe(A.user);
      expect(new Date(r.updated_at).getUTCFullYear()).toBeGreaterThan(2020);
    });
  });

  it('a write with no session user is refused', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await codeOf(c, INS, [A.id, 'day_of_month', 25])).toBe('42501');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
