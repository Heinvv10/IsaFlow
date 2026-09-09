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
import { postDualDepreciationToLedger } from '../../src/modules/accounting/services/gl/assetDepreciationPosting';
import { previewDepreciationJournals } from '../../src/modules/accounting/services/items/depreciationRunPreview';
import { calculateDepreciation } from '../../src/modules/accounting/services/items/assetService';
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
const expiredId = crypto.randomUUID();
const expiredNoTaxId = crypto.randomUUID();

const PERIOD = '2026-09-30';

// Every asset is purchased 2024-01-15 and run for 2026-09, which is month 32
// of its life — depreciation year 3.
//
// R100 000, 5-year life, no residual, reducing balance at 2/5 on the
// YEAR-OPENING carrying amount: year 1 charges 40 000 (carrying 100 000),
// year 2 charges 24 000 (carrying 60 000), year 3 charges 36 000 x 2/5 =
// 14 400 -> 1 200.00 per month. Straight line would charge 1 666.67.
const REDUCING_BALANCE_MONTHLY = 1200;
// Opening accumulated for that schedule at month 32: 40 000 + 24 000 + 8 x 1 200.
const REDUCING_BALANCE_ACC_DEP = 73_600;
// R60 000, 3-year life: sum-of-years year 3 = 60000 x 1 / (3*4/2) = 10 000
//   -> 833.33 per month. Opening: 30 000 + 20 000 + 8 x 833.33.
const SUM_OF_YEARS_MONTHLY = 833.33;
const SUM_OF_YEARS_ACC_DEP = 56_666.64;
// R120 000, 10-year life, straight line — unchanged by this fix.
const STRAIGHT_LINE_MONTHLY = 1000;
// Month 32 of the life for every asset above.
const MONTHS_ELAPSED = 32;

async function seedAsset(
  id: string,
  companyId: string,
  number: string,
  price: number,
  life: number,
  method: string,
  accDep: number,
  purchaseDate = '2024-01-15',
) {
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       salvage_value,useful_life_years,depreciation_method,accumulated_depreciation,status)
     VALUES($1,$2,$3,$4,$9,$5,0,$6,$7,$8,'available')`,
    [id, companyId, number, `${method} plant`, price, life, method, accDep, purchaseDate],
  );
}

beforeAll(async () => {
  for (const [id, name] of [[company, 'K-029 fixture'], [otherCompany, 'K-029 other tenant']]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await seedAsset(reducingId, company, 'K029-0001', 100000, 5, 'reducing_balance', REDUCING_BALANCE_ACC_DEP);
  await seedAsset(sumOfYearsId, company, 'K029-0002', 60000, 3, 'sum_of_years', SUM_OF_YEARS_ACC_DEP);
  await seedAsset(straightId, company, 'K029-0003', 120000, 10, 'straight_line', 0);
  await seedAsset(otherTenantAssetId, otherCompany, 'K029-9001', 50000, 5, 'reducing_balance', 0);
  // Life ended in 2020 with R60 000 of the R100 000 still undepreciated — the
  // shape a part-migrated register carries into its first run after deploy.
  await seedAsset(expiredId, company, 'K029-0004', 100000, 5, 'straight_line', 40000, '2015-01-31');
  // The same shape but with its TAX track exhausted too, so the run charges it
  // nothing on either and it would otherwise leave the loop as an anonymous +1
  // to `skipped`, absent from `results` entirely.
  await seedAsset(expiredNoTaxId, company, 'K029-0005', 100000, 5, 'straight_line', 40000, '2015-01-31');
  await pool.query(
    'UPDATE assets SET tax_accumulated_depreciation = purchase_price WHERE id = $1',
    [expiredNoTaxId],
  );

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

// The plan and the result of the ONE run this period gets. K-027 keys the
// plan's `already_in_subledger` skip on the `asset_period_ledger` row, so a
// second plan for 2026-09 correctly skips every asset the first run wrote —
// including the life-expired ones, whose policy charge of zero means they take
// no entry number and were previously re-runnable for ever. The assertions
// below are about the run that happened, so they read its plan and its result
// rather than building a second one the guard is designed to refuse.
let firstPlan: Awaited<ReturnType<typeof planDepreciationRun>>;
let firstResult: Awaited<ReturnType<typeof executeDepreciationRun>>;

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
    // And it is NOT the straight-line charge the engine used to return.
    expect(policy.monthlyDep).not.toBeCloseTo(1_666.67, 2);
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
    expect(plan.postable).toHaveLength(5);

    firstPlan = plan;
    const result = await executeDepreciationRun(company, userId, plan, assets);
    firstResult = result;
    expect(result.glFailed).toBe(0);
    // Four are processed: the three live assets, plus the expired one whose
    // POLICY charge is zero but whose tax track still has life — exactly why it
    // must not be skipped out of the plan. The fifth charges nothing on either
    // track and is counted as skipped.
    expect(result.processed).toBe(4);
    expect(result.skipped).toBe(1);

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

  it('charges nothing for an asset already past its life, and says why', async () => {
    // Follow-up review HIGH-A: the final-month true-up used >=, so this asset
    // was handed its whole R60 000 remaining book value as one month's charge.
    const row = firstPlan.rows.find((r) => r.assetNumber === 'K029-0004');
    expect(row).toBeDefined();
    // It still posts — its tax track may have life left — but the note names
    // the stranded amount instead of the run silently moving it.
    expect(row!.skipReason).toBeNull();
    expect(row!.lifeExpiredNote).toContain('60000.00');
    expect(row!.lifeExpiredNote).toContain('prior-period correction');

    // No policy journal was posted for it by the run above.
    const { rows } = await pool.query(
      `SELECT 1 FROM gl_journal_entries WHERE company_id=$1 AND entry_number=$2`,
      [company, 'DEP-K029-0004-2026-09'],
    );
    expect(rows).toHaveLength(0);

    // And the subledger records a zero policy charge, not a 60 000 one.
    const ledger = await pool.query(
      `SELECT policy_current_dep FROM asset_period_ledger
        WHERE company_id=$1 AND asset_id=$2 AND yyyymm='202609'`,
      [company, expiredId],
    );
    expect(Number(ledger.rows[0]!.policy_current_dep)).toBe(0);
  });

  it('carries the life-expired note into the run result and the dry run', async () => {
    // Round-3 review MEDIUM-D: the note was computed, attached, and read by
    // nothing in production. Both consumers must show it.
    const assets = await loadDepreciationAssets(company);

    // 1. The dry run replaces its own generic "no depreciation left" wording,
    //    which reads as the opposite of the truth for this asset.
    const preview = await previewDepreciationJournals(company, firstPlan, assets);
    const previewRow = preview.writesWithoutJournal.find((w) => w.id === expiredId);
    expect(previewRow).toBeDefined();
    expect(previewRow!.reason).toBe('subledger_row_only_no_journal');
    expect(previewRow!.detail).toContain('60000.00');
    expect(previewRow!.detail).not.toContain('no policy depreciation left');

    // 2. The live run names it in `results`, which the REST route returns and
    //    the MCP tool maps, instead of an anonymous +1 to `skipped`.
    const result = firstResult;
    const resultRow = result.results.find((r) => r.assetNumber === 'K029-0004');
    expect(resultRow).toBeDefined();
    expect(resultRow!.policyDep).toBe(0);
    expect(resultRow!.lifeExpiredNote).toContain('60000.00');

    // Only the two expired assets carry a note; the three healthy ones posted a
    // charge and have none.
    expect(result.results.filter((r) => r.lifeExpiredNote !== undefined)).toHaveLength(2);

    // 3. The one that charges nothing on EITHER track is still named. It used
    //    to leave the loop as an anonymous +1 to `skipped` with no row at all.
    const bothTracksZero = result.results.find((r) => r.assetNumber === 'K029-0005');
    expect(bothTracksZero).toBeDefined();
    expect(bothTracksZero!.policyDep).toBe(0);
    expect(bothTracksZero!.taxDep).toBe(0);
    expect(bothTracksZero!.entryId).toBeNull();
    expect(bothTracksZero!.lifeExpiredNote).toContain('60000.00');
  });

  it('agrees with the asset-service calculator the CSV and the detail page read', () => {
    // K-029 review MEDIUM-4/5/6: two implementations of these methods existed
    // in the same directory and disagreed. One schedule now backs the run, the
    // preview, the depreciation CSV export and the asset detail page, so none
    // of them can quote a charge the GL contradicts.
    const cases = [
      { cost: 100_000, life: 5, method: 'reducing_balance', expected: REDUCING_BALANCE_MONTHLY },
      { cost: 60_000, life: 3, method: 'sum_of_years', expected: SUM_OF_YEARS_MONTHLY },
      { cost: 120_000, life: 10, method: 'straight_line', expected: STRAIGHT_LINE_MONTHLY },
    ] as const;
    for (const c of cases) {
      const viaAssetService = calculateDepreciation({
        cost: c.cost, salvageValue: 0, usefulLifeYears: c.life,
        monthsElapsed: MONTHS_ELAPSED, method: c.method,
      });
      expect(viaAssetService.monthlyAmount).toBeCloseTo(c.expected, 2);
    }
  });

  it('refreshes the rate and the opening balance when a period is reposted', async () => {
    // K-029 review LOW-8: the ON CONFLICT omitted policy_dep_rate, so a
    // reposted period kept the first run's rate — wrong under any method whose
    // rate moves year to year.
    const before = await pool.query(
      `SELECT policy_dep_rate, policy_opening_acc_dep FROM asset_period_ledger
        WHERE company_id=$1 AND asset_id=$2 AND yyyymm='202609'`,
      [company, reducingId],
    );
    // Year 3 of the schedule: 14 400 / 100 000 = 14.4%.
    expect(Number(before.rows[0]!.policy_dep_rate)).toBeCloseTo(0.144, 4);

    // Repost the same period as if it were year 1 (rate 40%).
    await postDualDepreciationToLedger(
      company, reducingId,
      {
        cost: 100_000, residualPct: 0, usefulLifeYears: 5, taxLifeYears: 5,
        purchaseDate: '2024-01-15', periodDate: '2024-06-30',
        openingAccDep: 0, deferredTaxRate: 0.27,
        method: 'reducing_balance',
      },
      '202609', userId,
    );

    const after = await pool.query(
      `SELECT policy_dep_rate, policy_opening_acc_dep FROM asset_period_ledger
        WHERE company_id=$1 AND asset_id=$2 AND yyyymm='202609'`,
      [company, reducingId],
    );
    expect(Number(after.rows[0]!.policy_dep_rate)).toBeCloseTo(0.4, 4);
    expect(Number(after.rows[0]!.policy_opening_acc_dep)).toBeCloseTo(0, 2);
  });
});
