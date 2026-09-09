/**
 * K-027 RED. The dual-track depreciation run recomputes tax depreciation from a
 * stale opening balance, because nothing ever writes the tax side back.
 *
 *   depreciationRunPlan.ts:108   reads taxOpeningAccDep from
 *                                COALESCE(a.tax_accumulated_depreciation, 0)
 *   depreciationRunService.ts:159 passes it to postDualDepreciationToLedger
 *   assetDepreciationPosting.ts:137-143 the ONLY write-back updates
 *                                accumulated_depreciation and current_book_value.
 *                                tax_accumulated_depreciation / tax_book_value
 *                                are never touched.
 *
 * So every period opens on tax accumulated depreciation of 0 and the closing
 * balance never accumulates.
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
const asset = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const otherAsset = crypto.randomUUID();

// Cost 120 000, 10-year policy life, 5-year tax life, bought 2025-12-15.
// Tax: 120000 / 5 / 12 = 2000.00 per month. Jan and Feb 2026 both depreciate.
const COST = 120000;
const MONTHLY_TAX_DEP = 2000;

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
    [company, code, name, type, subtype, normal],
  );
}

async function runPeriod(periodDate: string) {
  const assets = await loadDepreciationAssets(company);
  const plan = await planDepreciationRun(company, periodDate, assets);
  return executeDepreciationRun(company, user, plan, assets);
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K027 depreciation fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, user, 'admin']);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K027 Jan 2026',1,2026,'2026-01-01','2026-01-31','open'),
           ($1,'K027 Feb 2026',2,2026,'2026-02-01','2026-02-28','open'),
           ($1,'K027 Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`,
    [company],
  );
  await account('6100', 'K027 Depreciation expense', 'expense', 'depreciation_expense', 'debit');
  await account('1590', 'K027 Accumulated depreciation', 'asset', 'accumulated_depreciation', 'credit');
  clearSystemAccountCache(company);
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       useful_life_years,tax_useful_life_years,salvage_value,status)
     VALUES($1,$2,'A-K027','K027 Plant','2025-12-15',$3,10,5,0,'available')`,
    [asset, company, COST],
  );
  // A second tenant holding an identical asset, never run. The write-back is
  // company-scoped, so nothing here may move.
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K027 other tenant')", [otherCompany]);
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       useful_life_years,tax_useful_life_years,salvage_value,status)
     VALUES($1,$2,'A-K027','K027 Other tenant plant','2025-12-15',$3,10,5,0,'available')`,
    [otherAsset, otherCompany, COST],
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
    await pool.query('DELETE FROM assets WHERE company_id=$1', [otherCompany]);
    await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
  } finally { await pool.end(); }
});

it('January posts one period of tax depreciation', async () => {
  const jan = await runPeriod('2026-01-31');
  expect(jan.glFailed).toBe(0);
  expect(jan.processed).toBe(1);
  expect(jan.results[0]!.taxDep).toBeCloseTo(MONTHLY_TAX_DEP, 2);
});

it('the run writes the tax accumulation back to the asset', async () => {
  const { rows } = await pool.query(
    'SELECT tax_accumulated_depreciation::float8 AS tax_acc, accumulated_depreciation::float8 AS pol_acc FROM assets WHERE id=$1',
    [asset],
  );
  // Policy side IS written back (assetDepreciationPosting.ts:137-143).
  expect(rows[0].pol_acc).toBeGreaterThan(0);
  // Tax side is not — this is the defect.
  expect(rows[0].tax_acc).toBeCloseTo(MONTHLY_TAX_DEP, 2);
});

it('February opens on January closing tax accumulated depreciation, not on zero', async () => {
  await runPeriod('2026-02-28');
  const { rows } = await pool.query(
    `SELECT yyyymm, tax_opening_acc_dep::float8 AS opening, tax_current_dep::float8 AS current,
            tax_closing_acc_dep::float8 AS closing, tax_carrying_amount::float8 AS carrying
       FROM asset_period_ledger WHERE asset_id=$1 ORDER BY yyyymm`,
    [asset],
  );
  expect(rows.map(r => r.yyyymm)).toEqual(['202601', '202602']);
  expect(rows[0].closing).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  // February must open where January closed.
  expect(rows[1].opening).toBeCloseTo(MONTHLY_TAX_DEP, 2);
  expect(rows[1].closing).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
  expect(rows[1].carrying).toBeCloseTo(COST - MONTHLY_TAX_DEP * 2, 2);
});

it('re-running a posted period does not double the tax accumulation', async () => {
  // `already_posted` skips the asset in the plan, so the SET never re-applies.
  const rerun = await runPeriod('2026-01-31');
  expect(rerun.processed).toBe(0);
  expect(rerun.skipped).toBe(1);
  const { rows } = await pool.query(
    'SELECT tax_accumulated_depreciation::float8 AS tax_acc FROM assets WHERE id=$1',
    [asset],
  );
  expect(rows[0].tax_acc).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
});

it('a dry run (plan without execute) writes nothing', async () => {
  const assets = await loadDepreciationAssets(company);
  const plan = await planDepreciationRun(company, '2026-03-31', assets);
  expect(plan.blocker).toBeNull();
  expect(plan.postable.length).toBe(1);
  const ledger = await pool.query(
    "SELECT 1 FROM asset_period_ledger WHERE asset_id=$1 AND yyyymm='202603'", [asset],
  );
  expect(ledger.rowCount).toBe(0);
  const { rows } = await pool.query(
    'SELECT tax_accumulated_depreciation::float8 AS tax_acc, tax_book_value::float8 AS tax_bv FROM assets WHERE id=$1',
    [asset],
  );
  expect(rows[0].tax_acc).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
  expect(rows[0].tax_bv).toBeCloseTo(COST - MONTHLY_TAX_DEP * 2, 2);
});

it("leaves a second company's assets untouched", async () => {
  const { rows } = await pool.query(
    `SELECT tax_accumulated_depreciation::float8 AS tax_acc, tax_book_value AS tax_bv,
            tax_book_value::float8 AS tax_bv_num, accumulated_depreciation::float8 AS pol_acc
       FROM assets WHERE id=$1 AND company_id=$2`,
    [otherAsset, otherCompany],
  );
  expect(rows[0].tax_acc).toBe(0);
  // Untouched: still the value the INSERT left (cost, no depreciation applied).
  expect(rows[0].tax_bv_num).toBeCloseTo(COST, 2);
  expect(rows[0].pol_acc ?? 0).toBe(0);
  const ledger = await pool.query('SELECT 1 FROM asset_period_ledger WHERE company_id=$1', [otherCompany]);
  expect(ledger.rowCount).toBe(0);
});
