/**
 * Migration 947's conversion, run as shipped (its DO block, extracted from the file) on legacy-shaped
 * rows (version_id NULL) inside a rolled-back transaction: company X across two registry years (the
 * first a 14-month transition year), company Y in one. Every row lands, in place, in an approved
 * primary 'Original' of the registry year holding its month, and count and sum per company and per
 * account are unchanged. A conversion that changes an amount makes the block raise
 * '947 verification failed'.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());

const MIGRATION = new URL('../../scripts/migrations/sql/947_budget_versions.sql', import.meta.url);
const block = /\nDO \$\$\nDECLARE\n {2}before jsonb;[\s\S]*?\n\$\$;/.exec(readFileSync(MIGRATION, 'utf8'))?.[0];

const X = crypto.randomUUID(), Y = crypto.randomUUID();
const xa = crypto.randomUUID(), xb = crypto.randomUUID(), ya = crypto.randomUUID();

/** Legacy-shaped rows on a clean slate: other suites' rows are removed inside the transaction only. */
async function legacy(c: PoolClient): Promise<void> {
  await c.query('ALTER TABLE budget_month_amounts ALTER COLUMN version_id DROP NOT NULL');
  // Locked versions' rows refuse DELETE; the trigger is off only inside this rolled-back transaction.
  await c.query('ALTER TABLE budget_month_amounts DISABLE TRIGGER trg_budget_month_amounts_refuse_locked');
  await c.query('DELETE FROM budget_month_amounts');
  await c.query('ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_refuse_locked');
  await c.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BV947 conv X', 3), ($2, 'BV947 conv Y', 3)`, [X, Y]);
  await c.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $4, 'CV-5000', 'Rent', 'expense', 'debit', 3, true), ($2, $4, 'CV-6000', 'Wages', 'expense', 'debit', 3, true),
            ($3, $5, 'CV-5000', 'Rent', 'expense', 'debit', 3, true)`, [xa, xb, ya, X, Y]);
  // X: FY2027 is a 14-month transition year (March 2026 - April 2027), FY2028 May 2027 - April 2028. Y: FY2027 only.
  await c.query(
    `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
     VALUES ($1, 2027, '2026-03-01', '2027-04-30', 'transition'), ($1, 2028, '2027-05-01', '2028-04-30', 'normal'),
            ($2, 2027, '2026-03-01', '2027-02-28', 'normal')`, [X, Y]);
  // X/xa: all 14 months of FY2027 plus 3 of FY2028; X/xb: 2 months; Y/ya: 12 months.
  await c.query(
    `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount)
     SELECT $1, $2, (DATE '2026-03-01' + make_interval(months => g))::date, 100 + g FROM generate_series(0, 16) g`, [X, xa]);
  await c.query(
    `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount) VALUES ($1, $2, '2027-04-01', 5.55), ($1, $2, '2027-05-01', 6.45)`, [X, xb]);
  await c.query(
    `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount)
     SELECT $1, $2, (DATE '2026-03-01' + make_interval(months => g))::date, 10 FROM generate_series(0, 11) g`, [Y, ya]);
}

async function inTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL client_min_messages = warning');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('947 conversion (the DO block as shipped)', () => {
  it('the block is found in the migration', () => {
    expect(block, 'the conversion DO block of migration 947').toBeTruthy();
  });

  it('files every row in place under an approved primary Original of the registry year of its month; totals unchanged', async () => {
    await inTx(async (c) => {
      await legacy(c);
      const ids = (await c.query('SELECT id FROM budget_month_amounts ORDER BY id')).rows.map((r) => r.id);
      const before = (await c.query(
        `SELECT company_id, gl_account_id, COUNT(*)::int n, SUM(amount)::text total FROM budget_month_amounts GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
      await c.query(block!);

      // In place: the same row ids, nothing inserted or deleted.
      expect((await c.query('SELECT id FROM budget_month_amounts ORDER BY id')).rows.map((r) => r.id)).toEqual(ids);
      const versions = (await c.query(
        `SELECT company_id, fiscal_year, name, kind, status, is_primary, approved_by, created_by
           FROM budget_versions WHERE company_id = ANY($1) ORDER BY company_id = $2 DESC, fiscal_year`, [[X, Y], X])).rows;
      const sys = 'system:migration-947';
      const original = { name: 'Original', kind: 'original', status: 'approved', is_primary: true, approved_by: sys, created_by: sys };
      expect(versions).toEqual([
        { company_id: X, fiscal_year: 2027, ...original }, { company_id: X, fiscal_year: 2028, ...original },
        { company_id: Y, fiscal_year: 2027, ...original }]);
      // Every row's version year is the registry year of its month: 14 + 3 for X/xa.
      const misfiled = (await c.query(
        `SELECT COUNT(*)::int n FROM budget_month_amounts bm JOIN budget_versions v ON v.id = bm.version_id
          WHERE v.fiscal_year <> (SELECT fiscal_year FROM public.fiscal_year_for_date(bm.company_id, bm.month))`)).rows[0].n;
      expect(misfiled).toBe(0);
      const perYear = (await c.query(
        `SELECT v.fiscal_year, COUNT(*)::int n FROM budget_month_amounts bm JOIN budget_versions v ON v.id = bm.version_id
          WHERE bm.gl_account_id = $1 GROUP BY 1 ORDER BY 1`, [xa])).rows;
      expect(perYear).toEqual([{ fiscal_year: 2027, n: 14 }, { fiscal_year: 2028, n: 3 }]);
      const after = (await c.query(
        `SELECT bm.company_id, bm.gl_account_id, COUNT(*)::int n, SUM(bm.amount)::text total
           FROM budget_month_amounts bm JOIN budget_versions v ON v.id = bm.version_id AND v.is_primary
          GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
      expect(after).toEqual(before);
    });
  });

  it('a conversion that changes an amount (count unchanged) makes the block raise 947 verification failed', async () => {
    await inTx(async (c) => {
      await legacy(c);
      // Sabotage, test-only: when a row gets its version, nudge its amount by a cent.
      await c.query(`CREATE FUNCTION pg_temp.bv947_sabotage() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.version_id IS NULL AND NEW.version_id IS NOT NULL AND NEW.gl_account_id = '${xb}' THEN
            UPDATE budget_month_amounts SET amount = amount + 0.01 WHERE id = NEW.id;
          END IF;
          RETURN NULL;
        END $$`);
      await c.query(`CREATE TRIGGER bv947_sabotage AFTER UPDATE ON budget_month_amounts FOR EACH ROW EXECUTE FUNCTION pg_temp.bv947_sabotage()`);
      await expect(c.query(block!)).rejects.toThrow(/947 verification failed/);
    });
  });

  it('a month the registry cannot place stops the conversion, naming the company and month', async () => {
    await inTx(async (c) => {
      await legacy(c);
      // A stored year far from any month: the registry refuses the year 3000.
      await c.query(`INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount) VALUES ($1, $2, '3000-01-01', 1)`, [Y, ya]);
      await expect(c.query(block!)).rejects.toThrow(new RegExp(`budget month 3000-01-01 of company ${Y} has no financial year`));
    });
  });
});
