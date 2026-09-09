/**
 * K-051 — merging into a level 1 or 2 target turns the target into a header
 * account and hides the merged balance from the balance sheet.
 *
 * assertMergeable (accountMergeGuards.ts) checks type, reporting class,
 * activity, cycles, system-account and reference constraints, and now the
 * target's LEVEL. mergeAccounts reparents the source's children onto the
 * target (accountMergeService.ts:165-173). balanceSheetService.ts:120-128
 * selects an account only when `level >= 3 OR it has no children`, so a target
 * at level <= 2 that acquires children drops out of the balance sheet entirely,
 * carrying its own balance and the merged one with it.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { mergeAccounts } from '../../src/modules/accounting/services/gl/accountMergeService';
import { getBalanceSheet } from '../../src/modules/accounting/services/reports/balanceSheetService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const target = crypto.randomUUID(), source = crypto.randomUUID(), child = crypto.randomUUID();
const equity = crypto.randomUUID();
const leafTarget = crypto.randomUUID(), leafSource = crypto.randomUUID();
const headerTarget = crypto.randomUUID(), headerChild = crypto.randomUUID();
const flatSource = crypto.randomUUID();
const crossTarget = crypto.randomUUID(), crossSource = crypto.randomUUID();
const foreignChild = crypto.randomUUID();
const AS_AT = '2026-03-31';

async function postJournal(entryNumber: string, legs: [string, number, number][]) {
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,posted_at)
     VALUES($1,$2,'2026-03-15'::date,$3,'manual','posted',$4,NOW()) RETURNING id`,
    [company, entryNumber, entryNumber, user]);
  for (const [account, debit, credit] of legs) {
    await pool.query(
      'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
      [rows[0].id, account, debit, credit, company]);
  }
}

async function assetsOnBalanceSheet(): Promise<number> {
  const bs = await getBalanceSheet(company, AS_AT);
  return bs.totalAssets;
}

/** withAuth supplies the request transaction the merge's row lock requires. */
async function runMerge(sourceId: string, targetId: string) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(
      { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      () => mergeAccounts(company, sourceId, targetId, user),
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { (client as PoolClient).release(); }
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K051 merge fixture')", [company]);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K051 other tenant')", [otherCompany]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K051-1100','K051 Trade receivables','asset','debit',2,true,NULL),
            ($3,$2,'K051-1150','K051 Legacy receivables','asset','debit',3,true,NULL),
            ($4,$2,'K051-1151','K051 Legacy sub-ledger','asset','debit',4,true,$3),
            ($5,$2,'K051-3000','K051 Retained earnings','equity','credit',3,true,NULL),
            ($6,$2,'K051-1200','K051 Prepayments','asset','debit',3,true,NULL),
            ($7,$2,'K051-1250','K051 Deposits','asset','debit',3,true,NULL),
            ($8,$2,'K051-1300','K051 Inventory (header)','asset','debit',2,true,NULL),
            ($9,$2,'K051-1310','K051 Inventory detail','asset','debit',3,true,$8),
            ($10,$2,'K051-1350','K051 Consumables','asset','debit',3,true,NULL),
            ($11,$2,'K051-1400','K051 Loans (level 1 leaf)','asset','debit',1,true,NULL),
            ($12,$2,'K051-1450','K051 Staff loans','asset','debit',3,true,NULL)`,
    [target, company, source, child, equity, leafTarget, leafSource,
      headerTarget, headerChild, flatSource, crossTarget, crossSource]);
  // Another tenant's account parented under this company's level-1 leaf. It must
  // not make that account a header for THIS company.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K051-9900','K051 foreign child','asset','debit',3,true,$3)`,
    [foreignChild, otherCompany, crossTarget]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K051 Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`, [company]);

  await postJournal('K051-JE-TARGET', [[target, 500, 0], [equity, 0, 500]]);
  await postJournal('K051-JE-SOURCE', [[source, 1000, 0], [equity, 0, 1000]]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_account_merges WHERE company_id=ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=ANY($1))', [[company, otherCompany]]);
    await pool.query('UPDATE gl_accounts SET parent_account_id=NULL WHERE company_id=ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses a merge that would turn the target into a header account', async () => {
  expect(await assetsOnBalanceSheet()).toBeCloseTo(1500, 2);

  await expect(runMerge(source, target)).rejects.toMatchObject({ code: 'target_becomes_header' });

  // Nothing moved: both accounts still carry their own balance on the report.
  expect(await assetsOnBalanceSheet()).toBeCloseTo(1500, 2);
  const { rows } = await pool.query(
    'SELECT parent_account_id, is_active FROM gl_accounts WHERE id=$1 AND company_id=$2',
    [child, company]);
  expect(rows[0].parent_account_id).toBe(source);
});

it('refuses a level-2 target that is ALREADY a header, even from a childless source', async () => {
  await expect(runMerge(flatSource, headerTarget))
    .rejects.toMatchObject({ code: 'target_becomes_header' });
});

it('still merges into a leaf target, and the balance sheet is unchanged', async () => {
  const before = await assetsOnBalanceSheet();
  const result = await runMerge(leafSource, leafTarget);
  expect(result.sourceDeactivated).toBe(true);
  // A repoint moves no debit and no credit — total assets must be unchanged.
  expect(await assetsOnBalanceSheet()).toBeCloseTo(before, 2);
});

it("ignores another tenant's child when judging a level-1 leaf target", async () => {
  const result = await runMerge(crossSource, crossTarget);
  expect(result.targetAccountCode).toBe('K051-1400');
  const { rows } = await pool.query(
    'SELECT parent_account_id FROM gl_accounts WHERE id=$1 AND company_id=$2',
    [foreignChild, otherCompany]);
  expect(rows[0].parent_account_id).toBe(crossTarget);
});
