/**
 * K-027 follow-up. The two paths the first fix got wrong, from the blind review
 * of 71c70ece — both measured against real Postgres before the correction.
 *
 *  1. An asset whose POLICY depreciation is exhausted while tax still runs
 *     never takes a journal entry number (`postAssetDepreciationToGLThrows`
 *     returns early on a charge of zero), so the plan's `already_posted` guard
 *     never fires and each re-run doubled `tax_accumulated_depreciation`.
 *  2. `period_date` is caller-supplied. Posting February and then January set
 *     the asset to JANUARY's closing balance, regressing the column by a month
 *     and double-counting it on the next run.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loadDepreciationAssets, planDepreciationRun } from '@/modules/accounting/services/items/depreciationRunPlan';
import { executeDepreciationRun } from '@/modules/accounting/services/items/depreciationRunService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
// Policy exhausted (accumulated = full depreciable amount), tax untouched.
const exhausted = crypto.randomUUID();
// Fresh asset, used only for the out-of-order posting case.
const outOfOrder = crypto.randomUUID();

const COST = 120000;
const MONTHLY_TAX_DEP = 2000;

async function runPeriod(periodDate: string) {
  const assets = await loadDepreciationAssets(company);
  const plan = await planDepreciationRun(company, periodDate, assets);
  return { plan, result: await executeDepreciationRun(company, user, plan, assets) };
}

async function assetTax(id: string) {
  const { rows } = await pool.query(
    `SELECT tax_accumulated_depreciation::float8 AS acc, tax_book_value::float8 AS bv
       FROM assets WHERE id=$1 AND company_id=$2`,
    [id, company],
  );
  return rows[0] as { acc: number; bv: number };
}

async function journalCount(assetNumber: string) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND entry_number LIKE $2",
    [company, `DEP-${assetNumber}-%`],
  );
  return rows[0].n as number;
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K027 idempotency fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, user, 'admin']);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K027i Jan 2026',1,2026,'2026-01-01','2026-01-31','open'),
           ($1,'K027i Feb 2026',2,2026,'2026-02-01','2026-02-28','open'),
           ($1,'K027i Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`,
    [company],
  );
  for (const [code, name, type, subtype, normal] of [
    ['6100', 'K027i Depreciation expense', 'expense', 'depreciation_expense', 'debit'],
    ['1590', 'K027i Accumulated depreciation', 'asset', 'accumulated_depreciation', 'credit'],
  ]) {
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
         normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
      [company, code, name, type, subtype, normal],
    );
  }
  clearSystemAccountCache(company);
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       useful_life_years,tax_useful_life_years,salvage_value,status,accumulated_depreciation)
     VALUES($1,$2,'A-K027-EX','K027 Policy-exhausted plant','2025-12-15',$3,10,5,0,'available',$3)`,
    [exhausted, company, COST],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM asset_period_ledger WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM assets WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('an asset at policy 0 with tax still running posts tax but no journal', async () => {
  const { result } = await runPeriod('2026-01-31');
  expect(result.processed).toBe(1);
  expect(result.glFailed).toBe(0);
  expect(result.results[0]!.policyDep).toBeCloseTo(0, 2);
  expect(result.results[0]!.taxDep).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  // No journal: the GL post returns early on a charge of zero. This is exactly
  // why the entry-number guard cannot protect the tax write-back.
  expect(await journalCount('A-K027-EX')).toBe(0);
  const a = await assetTax(exhausted);
  expect(a.acc).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  expect(a.bv).toBeCloseTo(COST - MONTHLY_TAX_DEP, 2);
});

it('re-running that period does NOT double the tax accumulation', async () => {
  const { plan, result } = await runPeriod('2026-01-31');
  // Skipped on the subledger row, since no entry number was ever taken.
  const row = plan.rows.find((r) => r.assetNumber === 'A-K027-EX');
  expect(row!.skipReason).toBe('already_in_subledger');
  expect(result.processed).toBe(0);

  const a = await assetTax(exhausted);
  expect(a.acc).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  expect(a.bv).toBeCloseTo(COST - MONTHLY_TAX_DEP, 2);

  // The subledger row must still describe ONE month of wear, not two.
  const { rows } = await pool.query(
    `SELECT tax_opening_acc_dep::float8 AS opening, tax_current_dep::float8 AS current,
            tax_closing_acc_dep::float8 AS closing
       FROM asset_period_ledger WHERE asset_id=$1 AND yyyymm='202601'`,
    [exhausted],
  );
  expect(rows[0].opening).toBeCloseTo(0, 2);
  expect(rows[0].current).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  expect(rows[0].closing).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  expect(await journalCount('A-K027-EX')).toBe(0);
});

it('posting February then January leaves the asset on the LATEST period', async () => {
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       useful_life_years,tax_useful_life_years,salvage_value,status)
     VALUES($1,$2,'A-K027-OOO','K027 Out-of-order plant','2025-12-15',$3,10,5,0,'available')`,
    [outOfOrder, company, COST],
  );

  await runPeriod('2026-02-28');
  expect((await assetTax(outOfOrder)).acc).toBeCloseTo(MONTHLY_TAX_DEP, 2);

  // Back-posting January must not regress the column to January's closing.
  await runPeriod('2026-01-31');
  const a = await assetTax(outOfOrder);
  expect(a.acc).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  expect(a.bv).toBeCloseTo(COST - MONTHLY_TAX_DEP, 2);

  // One journal per period, no more.
  expect(await journalCount('A-K027-OOO')).toBe(2);
});

it('March then opens on February closing, not on a doubled balance', async () => {
  await runPeriod('2026-03-31');
  const { rows } = await pool.query(
    `SELECT tax_opening_acc_dep::float8 AS opening, tax_closing_acc_dep::float8 AS closing
       FROM asset_period_ledger WHERE asset_id=$1 AND yyyymm='202603'`,
    [outOfOrder],
  );
  expect(rows[0].opening).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  expect(rows[0].closing).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
  expect((await assetTax(outOfOrder)).acc).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
});
