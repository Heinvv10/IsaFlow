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
import { lockAssetTaxBase, writeAssetTaxAccumulation } from '@/modules/accounting/services/gl/assetTaxAccumulation';
import { als } from '@/lib/als';

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

it('back-posting January after February keeps BOTH periods in the accumulation', async () => {
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       useful_life_years,tax_useful_life_years,salvage_value,status)
     VALUES($1,$2,'A-K027-OOO','K027 Out-of-order plant','2025-12-15',$3,10,5,0,'available')`,
    [outOfOrder, company, COST],
  );

  await runPeriod('2026-02-28');
  expect((await assetTax(outOfOrder)).acc).toBeCloseTo(MONTHLY_TAX_DEP, 2);

  // Back-posting January must neither regress the column to January's closing
  // nor drop January's charge. Both periods were charged, so both must show.
  await runPeriod('2026-01-31');
  const a = await assetTax(outOfOrder);
  expect(a.acc).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
  expect(a.bv).toBeCloseTo(COST - MONTHLY_TAX_DEP * 2, 2);

  // January opens at 0, not on February's balance: the opening comes from the
  // subledger periods BEFORE it, of which there are none.
  const { rows } = await pool.query(
    `SELECT tax_opening_acc_dep::float8 AS opening FROM asset_period_ledger
       WHERE asset_id=$1 AND yyyymm='202601'`,
    [outOfOrder],
  );
  expect(rows[0].opening).toBeCloseTo(0, 2);

  // One journal per period, no more.
  expect(await journalCount('A-K027-OOO')).toBe(2);
});

it('March opens on the subledger total, and the asset equals every charge made', async () => {
  await runPeriod('2026-03-31');
  const { rows } = await pool.query(
    `SELECT yyyymm, tax_opening_acc_dep::float8 AS opening, tax_current_dep::float8 AS current
       FROM asset_period_ledger WHERE asset_id=$1 ORDER BY yyyymm`,
    [outOfOrder],
  );
  // Three periods posted Feb, Jan, Mar. March opens on the SUM of the two
  // already charged, not on whatever the asset column last happened to hold.
  expect(rows.map((r) => r.yyyymm)).toEqual(['202601', '202602', '202603']);
  expect(rows[2].opening).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);

  const charged = rows.reduce((n, r) => n + r.current, 0);
  expect(charged).toBeCloseTo(MONTHLY_TAX_DEP * 3, 2);

  // The invariant that was broken: the cached column must equal what the
  // subledger actually charged. It read 4 000 against 6 000 charged before the
  // opening moved off the asset column.
  const a = await assetTax(outOfOrder);
  expect(a.acc).toBeCloseTo(charged, 2);
  expect(a.bv).toBeCloseTo(COST - charged, 2);
});

/** Run fn on its own client inside a transaction the caller closes. */
async function begin() {
  const c = await pool.connect();
  await c.query('BEGIN');
  return c;
}
function on<T>(client: Awaited<ReturnType<typeof pool.connect>>, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: user, companyId: company, claims: {} } as never, fn);
}

async function insertLedgerRaw(
  asset: string, periodDate: string, yyyymm: string, opening: number,
) {
  await pool.query(
    `INSERT INTO asset_period_ledger(company_id,asset_id,period_date,yyyymm,
       policy_cost,policy_opening_acc_dep,policy_current_dep,policy_closing_acc_dep,
       policy_carrying_amount,policy_dep_rate,tax_cost,tax_opening_acc_dep,
       tax_current_dep,tax_closing_acc_dep,tax_carrying_amount,deferred_tax)
     VALUES($1,$2,$3::date,$4,$5,0,1000,1000,$5,0.1,$5,$6,$7,$8,0,0)`,
    [company, asset, periodDate, yyyymm, COST, opening, MONTHLY_TAX_DEP, opening + MONTHLY_TAX_DEP],
  );
}

async function insertLedger(
  client: Awaited<ReturnType<typeof pool.connect>>,
  asset: string, periodDate: string, yyyymm: string, opening: number,
) {
  await client.query(
    `INSERT INTO asset_period_ledger(company_id,asset_id,period_date,yyyymm,
       policy_cost,policy_opening_acc_dep,policy_current_dep,policy_closing_acc_dep,
       policy_carrying_amount,policy_dep_rate,tax_cost,tax_opening_acc_dep,
       tax_current_dep,tax_closing_acc_dep,tax_carrying_amount,deferred_tax)
     VALUES($1,$2,$3::date,$4,$5,0,1000,1000,$5,0.1,$5,$6,$7,$8,$9,0)`,
    [company, asset, periodDate, yyyymm, COST, opening, MONTHLY_TAX_DEP,
      opening + MONTHLY_TAX_DEP, COST - (opening + MONTHLY_TAX_DEP)],
  );
}

/**
 * The property the write-back rests on, proved through the production functions
 * rather than through raw SQL that takes its own lock.
 *
 * Re-reading the subledger inside the transaction is NOT enough on its own: the
 * subquery runs under the reader's own snapshot and cannot see a row the other
 * transaction has not committed. Without `FOR UPDATE` both sessions read the
 * same opening, both write an absolute figure, and the later commit drops the
 * earlier period's charge — the column ends a period behind while both journals
 * exist.
 */
it('two concurrent sessions posting different periods both keep their charge', async () => {
  const asset = crypto.randomUUID();
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       useful_life_years,tax_useful_life_years,salvage_value,status)
     VALUES($1,$2,'A-K027-CC','K027 Concurrent plant','2025-12-15',$3,10,5,0,'available')`,
    [asset, company, COST],
  );

  const a = await begin();
  const b = await begin();
  try {
    const baseA = await on(a, () => lockAssetTaxBase(company, asset, '202601'));
    expect(baseA.openingForPeriod).toBeCloseTo(0, 2);
    expect(baseA.accumulatedElsewhere).toBeCloseTo(0, 2);

    // B asks for the same asset and must WAIT rather than read past A.
    let bSettled = false;
    const contender = on(b, () => lockAssetTaxBase(company, asset, '202602'))
      .then((r) => { bSettled = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(bSettled).toBe(false);

    await insertLedger(a, asset, '2026-01-31', '202601', baseA.openingForPeriod);
    await on(a, () => writeAssetTaxAccumulation(
      company, asset, COST, baseA.accumulatedElsewhere + MONTHLY_TAX_DEP,
    ));
    await a.query('COMMIT');

    // Released. B now reads a snapshot that includes A's committed period.
    const baseB = await contender;
    expect(baseB.openingForPeriod).toBeCloseTo(MONTHLY_TAX_DEP, 2);
    expect(baseB.accumulatedElsewhere).toBeCloseTo(MONTHLY_TAX_DEP, 2);

    await insertLedger(b, asset, '2026-02-28', '202602', baseB.openingForPeriod);
    await on(b, () => writeAssetTaxAccumulation(
      company, asset, COST, baseB.accumulatedElsewhere + MONTHLY_TAX_DEP,
    ));
    await b.query('COMMIT');
  } finally {
    a.release();
    b.release();
  }

  // Neither charge was lost: 2 000 + 2 000, and the column agrees with them.
  const { rows } = await pool.query(
    `SELECT a.tax_accumulated_depreciation::float8 AS acc,
            a.tax_book_value::float8 AS bv,
            (SELECT COALESCE(SUM(tax_current_dep),0)::float8 FROM asset_period_ledger
               WHERE company_id=a.company_id AND asset_id=a.id) AS charged
       FROM assets a WHERE a.id=$1 AND a.company_id=$2`,
    [asset, company],
  );
  expect(rows[0].charged).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
  expect(rows[0].acc).toBeCloseTo(MONTHLY_TAX_DEP * 2, 2);
  expect(rows[0].bv).toBeCloseTo(COST - MONTHLY_TAX_DEP * 2, 2);
});

/**
 * The pre-fix damage shape. With the opening pinned at an un-accumulating 0,
 * `remaining = cost - opening` never fell to zero, so a full month was charged
 * for as many periods as the run was made. Any asset with more posted periods
 * than its tax life in months carries a subledger that has charged MORE than
 * the asset cost — and the cache is derived from that sum.
 */
it('caps the cached figures on a subledger that over-charged, and warns', async () => {
  const asset = crypto.randomUUID();
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,
       useful_life_years,tax_useful_life_years,salvage_value,status)
     VALUES($1,$2,'A-K027-OVER','K027 Over-charged plant','2019-12-15',$3,10,5,0,'available')`,
    [asset, company, COST],
  );
  // 70 periods of 2 000 = 140 000 charged against a 120 000 cost.
  for (let i = 0; i < 70; i += 1) {
    const y = 2020 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, '0');
    await insertLedgerRaw(asset, `${y}-${m}-28`, `${y}${m}`, i * MONTHLY_TAX_DEP);
  }

  await runPeriod('2026-01-31');

  const a = await assetTax(asset);
  // Capped at cost, never negative — this reaches the FAR report, and
  // dispose.ts values recoupment off the accumulation.
  expect(a.acc).toBeCloseTo(COST, 2);
  expect(a.bv).toBeCloseTo(0, 2);
  expect(a.bv).toBeGreaterThanOrEqual(0);
});
