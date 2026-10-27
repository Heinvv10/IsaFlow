/**
 * Rollback compatibility of migration 947 (spec §9): scripts/rollback-deploy.sh reverts code, never
 * migrations, so the PRE-P1 code must be safe on the post-947 schema. The SQL below is master's at
 * b205f7354 (src/modules/accounting/services/core/budgetService.ts and
 * src/modules/accounting/services/reports/budgetWindowService.ts), copied verbatim with each
 * `${…}` interpolation replaced by a numbered parameter. Legacy rows are converted by 947's own
 * function, then: old reads give the pre-conversion totals; the old upsert and copy fail 42P10 and
 * write nothing; an INSERT without a version fails NOT NULL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

// budgetService.ts loadEntries, second query ($1 companyId, $2 accountId, $3 year.first, $4 year.last).
const OLD_LOAD_STORED = `
    SELECT bm.gl_account_id, TO_CHAR(bm.month, 'YYYY-MM') AS month_key, bm.amount::text AS amount
    FROM budget_month_amounts bm
    WHERE bm.company_id = $1::UUID
      AND ($2::UUID IS NULL OR bm.gl_account_id = $2::UUID)
      AND bm.month >= $3::DATE AND bm.month <= $4::DATE
  `;
// budgetWindowService.ts loadWindowBudgets ($1 companyId, $2 bounds.first, $3 bounds.last).
const OLD_WINDOW = `
    SELECT bm.gl_account_id, ga.account_code, SUM(bm.amount)::numeric AS total
    FROM budget_month_amounts bm
    JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = $1::UUID
    WHERE bm.company_id = $1::UUID
      AND bm.month >= $2::DATE AND bm.month <= $3::DATE
    GROUP BY bm.gl_account_id, ga.account_code
  `;
// budgetService.ts upsertBudget ($1 companyId, $2 glAccountId, $3 months, $4 amounts, $5 userId).
const OLD_UPSERT = `
    INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount, created_by)
    SELECT $1::UUID, $2::UUID, t.month::DATE, t.amount, $5
    FROM unnest($3::TEXT[], $4::NUMERIC[])
      AS t(month, amount)
    ON CONFLICT (company_id, gl_account_id, month)
    DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()
  `;
// budgetService.ts copyBudgets ($1 to.first, $2 from.first, $3 companyId, $4 from.last, $5 userId, $6 to.last).
const OLD_COPY = `
    WITH moved AS (
      SELECT bm.gl_account_id, bm.amount,
             $1::DATE + make_interval(months =>
               (EXTRACT(YEAR FROM bm.month)::INT * 12 + EXTRACT(MONTH FROM bm.month)::INT)
               - (EXTRACT(YEAR FROM $2::DATE)::INT * 12 + EXTRACT(MONTH FROM $2::DATE)::INT)
             ) AS target
      FROM budget_month_amounts bm
      JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = $3::UUID
      WHERE bm.company_id = $3::UUID
        AND bm.month >= $2::DATE AND bm.month <= $4::DATE
    ), ins AS (
      INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount, created_by)
      SELECT $3::UUID, gl_account_id, target::DATE, amount, $5
      FROM moved WHERE target <= $6::DATE
      ON CONFLICT (company_id, gl_account_id, month) DO NOTHING
      RETURNING gl_account_id
    )
    SELECT COUNT(DISTINCT gl_account_id)::INT AS copied FROM ins
  `;

const co = crypto.randomUUID(), acct = crypto.randomUUID(), acct2 = crypto.randomUUID();

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BV947 compat', 3)`, [co]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, 'OC-5000', 'Rent', 'expense', 'debit', 3, true), ($2, $3, 'OC-6000', 'Wages', 'expense', 'debit', 3, true)`,
    [acct, acct2, co]);
  await pool.query(
    `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
     VALUES ($1, 2027, '2026-03-01', '2027-02-28', 'normal'), ($1, 2028, '2027-03-01', '2028-02-29', 'normal')`, [co]);
});
afterAll(async () => {
  try {
    for (const t of ['budget_month_amounts', 'budget_versions', 'gl_accounts', 'fiscal_periods', 'fiscal_years']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [co]);
  } finally {
    await pool.end();
  }
});

/** Legacy-shaped rows for this company only (version NULL), converted by 947's function, all in a rolled-back tx. */
async function converted(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE budget_month_amounts ALTER COLUMN version_id DROP NOT NULL');
    await c.query(
      `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount)
       SELECT $1, $2, (DATE '2026-03-01' + make_interval(months => g))::date, 100 FROM generate_series(0, 23) g`, [co, acct]);
    await c.query(
      `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount) VALUES ($1, $2, '2026-06-01', 7.25)`, [co, acct2]);
    expect((await c.query('SELECT public.budget_versions_from_months($1) n', [co])).rows[0].n).toBe(25);
    await c.query('ALTER TABLE budget_month_amounts ALTER COLUMN version_id SET NOT NULL');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const sumOf = (rows: Array<{ amount: string }>) => rows.reduce((s, r) => s + Number(r.amount), 0);

describe('947: pre-P1 code on the post-947 schema', () => {
  it('old reads give the pre-migration totals (the conversion is in place, one row per cell)', async () => {
    await converted(async (c) => {
      const fy2027 = (await c.query(OLD_LOAD_STORED, [co, null, '2026-03-01', '2027-02-01'])).rows;
      expect(fy2027).toHaveLength(13);
      expect(sumOf(fy2027)).toBe(1207.25);
      const window = (await c.query(OLD_WINDOW, [co, '2026-03-01', '2028-02-01'])).rows;
      const byCode = Object.fromEntries(window.map((r) => [r.account_code, Number(r.total)]));
      expect(byCode).toEqual({ 'OC-5000': 2400, 'OC-6000': 7.25 });
    });
  });

  it('the old upsert fails 42P10 at plan time and writes nothing', async () => {
    await converted(async (c) => {
      const n0 = (await c.query('SELECT COUNT(*)::int n, SUM(amount)::text s FROM budget_month_amounts WHERE company_id = $1', [co])).rows[0];
      await c.query('SAVEPOINT s');
      await expect(c.query(OLD_UPSERT, [co, acct, ['2026-03-01'], [999], 'old-code'])).rejects.toMatchObject({ code: '42P10' });
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expect(c.query(OLD_COPY, ['2027-03-01', '2026-03-01', co, '2027-02-01', 'old-code', '2028-02-01']))
        .rejects.toMatchObject({ code: '42P10' });
      await c.query('ROLLBACK TO SAVEPOINT s');
      const n1 = (await c.query('SELECT COUNT(*)::int n, SUM(amount)::text s FROM budget_month_amounts WHERE company_id = $1', [co])).rows[0];
      expect(n1).toEqual(n0);
    });
  });

  it('an INSERT that names no version fails NOT NULL (no default-filling trigger hides a writer that forgot it)', async () => {
    await converted(async (c) => {
      await expect(c.query(
        `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount) VALUES ($1, $2, '2027-06-01', 1)`, [co, acct2]))
        .rejects.toMatchObject({ code: '23502' });
    });
  });
});
