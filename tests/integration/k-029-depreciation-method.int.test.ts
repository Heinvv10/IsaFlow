/**
 * K-029 — the depreciation run must honour the asset's configured method.
 *
 * RED (origin/master): `loadDepreciationAssets` SELECTs no
 * `depreciation_method`, and `calculatePolicyDepreciation` had no method
 * parameter, so an asset created as `reducing_balance` was charged
 * straight-line by the run, the preview and the MCP tool alike.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  loadDepreciationAssets,
  planDepreciationRun,
} from '../../src/modules/accounting/services/items/depreciationRunPlan';
import { executeDepreciationRun } from '../../src/modules/accounting/services/items/depreciationRunService';
import {
  calculatePolicyDepreciation,
  toDepreciationMethod,
} from '../../src/modules/accounting/services/items/farDepreciationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const userId = crypto.randomUUID();
const reducingId = crypto.randomUUID();
const sumOfYearsId = crypto.randomUUID();
const straightId = crypto.randomUUID();
const otherTenantAssetId = crypto.randomUUID();

const PERIOD = '2026-09-30';

// R100 000 cost, 5-year life, no residual, R20 000 already depreciated.
//   straight line   : 100000 / 5 / 12                  = 1666.67 per month
//   reducing balance: (100000 - 20000) * (2 / 5) / 12  = 2666.67 per month
const REDUCING_BALANCE_MONTHLY = 2666.67;
// R60 000 cost, 3-year life, purchased 2024-01 so 2 whole years have elapsed:
//   sum-of-years: 60000 * (3 - 2) / (3*4/2) / 12       =  833.33 per month
const SUM_OF_YEARS_MONTHLY = 833.33;
// R120 000 cost, 10-year life, straight line — unchanged by this fix.
const STRAIGHT_LINE_MONTHLY = 1000;

async function seedAsset(
  id: string,
  companyId: string,
  number: string,
  price: number,
  life: number,
  method: string,
  accDep: number,
) {
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       salvage_value,useful_life_years,depreciation_method,accumulated_depreciation,status)
     VALUES($1,$2,$3,$4,'2024-01-15',$5,0,$6,$7,$8,'available')`,
    [id, companyId, number, `${method} plant`, price, life, method, accDep],
  );
}

beforeAll(async () => {
  for (const [id, name] of [[company, 'K-029 fixture'], [otherCompany, 'K-029 other tenant']]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await seedAsset(reducingId, company, 'K029-0001', 100000, 5, 'reducing_balance', 20000);
  await seedAsset(sumOfYearsId, company, 'K029-0002', 60000, 3, 'sum_of_years', 0);
  await seedAsset(straightId, company, 'K029-0003', 120000, 10, 'straight_line', 0);
  await seedAsset(otherTenantAssetId, otherCompany, 'K029-9001', 50000, 5, 'reducing_balance', 0);

  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'2026-09',9,2026,'2026-09-01','2026-09-30','open')`,
    [crypto.randomUUID(), company],
  );
  for (const [code, name, type, subtype, balance] of [
    ['6200', 'Depreciation', 'expense', 'depreciation_expense', 'debit'],
    ['1595', 'Accumulated depreciation', 'asset', 'accumulated_depreciation', 'credit'],
  ]) {
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,
         account_subtype,normal_balance,is_system_account,is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,true,true)`,
      [crypto.randomUUID(), company, code, name, type, subtype, balance],
    );
  }
});

afterAll(async () => {
  try {
    for (const id of [company, otherCompany]) {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM asset_period_ledger WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM assets WHERE company_id=$1', [id]);
      await pool.query(
        'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)',
        [id],
      );
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
  } finally {
    await pool.end();
  }
});

describe('K-029 depreciation method', () => {
  it('carries the configured depreciation method through to the posted charge', async () => {
    const assets = await loadDepreciationAssets(company);
    const asset = assets.find((a) => String(a.id) === reducingId);
    expect(asset).toBeDefined();

    // 1. The loader must expose the method the user chose.
    expect(asset).toHaveProperty('depreciation_method', 'reducing_balance');

    // 2. The charge for the period must follow that method.
    const policy = calculatePolicyDepreciation({
      cost: Number(asset!.cost),
      residualPct: Number(asset!.residual_pct),
      usefulLifeYears: Number(asset!.useful_life_years),
      purchaseDate: '2024-01-15',
      periodDate: PERIOD,
      openingAccDep: Number(asset!.policy_acc_dep),
      method: toDepreciationMethod(asset!.depreciation_method),
    });
    expect(policy.monthlyDep).toBeCloseTo(REDUCING_BALANCE_MONTHLY, 2);
  });

  it('scopes the loader to the calling tenant', async () => {
    const assets = await loadDepreciationAssets(company);
    expect(assets.map((a) => String(a.id))).not.toContain(otherTenantAssetId);
    const other = await loadDepreciationAssets(otherCompany);
    expect(other.map((a) => String(a.id))).toEqual([otherTenantAssetId]);
  });

  it('posts one balanced journal per asset at that asset method charge', async () => {
    const assets = await loadDepreciationAssets(company);
    const plan = await planDepreciationRun(company, PERIOD, assets);
    expect(plan.blocker).toBeNull();
    expect(plan.postable).toHaveLength(3);

    const result = await executeDepreciationRun(company, userId, plan, assets);
    expect(result.glFailed).toBe(0);
    expect(result.processed).toBe(3);

    const expected: Record<string, number> = {
      'K029-0001': REDUCING_BALANCE_MONTHLY,
      'K029-0002': SUM_OF_YEARS_MONTHLY,
      'K029-0003': STRAIGHT_LINE_MONTHLY,
    };

    for (const [assetNumber, charge] of Object.entries(expected)) {
      const { rows } = await pool.query(
        `SELECT l.debit, l.credit, a.account_subtype
           FROM gl_journal_entries e
           JOIN gl_journal_lines l ON l.journal_entry_id = e.id
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE e.company_id = $1 AND e.entry_number = $2`,
        [company, `DEP-${assetNumber}-2026-09`],
      );
      expect(rows).toHaveLength(2);

      const debits = rows.reduce((t, r) => t + Number(r.debit), 0);
      const credits = rows.reduce((t, r) => t + Number(r.credit), 0);
      // Balanced, and equal to the charge the asset's own method produces.
      expect(debits).toBeCloseTo(credits, 2);
      expect(debits).toBeCloseTo(charge, 2);
      expect(
        Number(rows.find((r) => r.account_subtype === 'depreciation_expense')!.debit),
      ).toBeCloseTo(charge, 2);
      expect(
        Number(rows.find((r) => r.account_subtype === 'accumulated_depreciation')!.credit),
      ).toBeCloseTo(charge, 2);

      // The subledger period row must agree with the journal.
      const ledger = await pool.query(
        `SELECT pl.policy_current_dep FROM asset_period_ledger pl
           JOIN assets s ON s.id = pl.asset_id
          WHERE pl.company_id = $1 AND s.asset_number = $2 AND pl.yyyymm = '202609'`,
        [company, assetNumber],
      );
      expect(Number(ledger.rows[0]!.policy_current_dep)).toBeCloseTo(charge, 2);
    }
  });
});
