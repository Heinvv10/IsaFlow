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
const deepTarget = crypto.randomUUID(), deepChild = crypto.randomUUID();
const deepSource = crypto.randomUUID(), deepSourceChild = crypto.randomUUID();
const expenseTarget = crypto.randomUUID(), expenseChild = crypto.randomUUID();
const expenseSource = crypto.randomUUID();
const ancSource = crypto.randomUUID(), ancTarget = crypto.randomUUID();
const ancGrand = crypto.randomUUID();
const linedSource = crypto.randomUUID();
const sageTarget = crypto.randomUUID(), sageSource = crypto.randomUUID();
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

/** The account's OWN line on the balance sheet, 0 when the report omits it. */
async function assetLine(accountCode: string): Promise<number> {
  const bs = await getBalanceSheet(company, AS_AT);
  return bs.assets.find((a) => a.accountCode === accountCode)?.balance ?? 0;
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
            ($12,$2,'K051-1450','K051 Staff loans','asset','debit',3,true,NULL),
            ($13,$2,'K051-1600','K051 Motor vehicles','asset','debit',3,true,NULL),
            ($14,$2,'K051-1610','K051 Motor vehicles - bakkies','asset','debit',4,true,$13),
            ($15,$2,'K051-1650','K051 Delivery vehicles','asset','debit',3,true,NULL),
            ($16,$2,'K051-1660','K051 Delivery vehicles - vans','asset','debit',4,true,$15),
            ($17,$2,'K051-6000','K051 Motor expenses (header)','expense','debit',2,true,NULL),
            ($18,$2,'K051-6010','K051 Fuel','expense','debit',3,true,$17),
            ($19,$2,'K051-6500','K051 Vehicle repairs','expense','debit',3,true,NULL),
            ($20,$2,'K051-1700','K051 Investments (level 1)','asset','debit',1,true,NULL),
            ($21,$2,'K051-1710','K051 Investments - listed','asset','debit',2,true,$20),
            ($22,$2,'K051-1720','K051 Investments - JSE','asset','debit',3,true,$21),
            ($23,$2,'K051-1800','K051 Petty cash','asset','debit',3,true,NULL)`,
    [target, company, source, child, equity, leafTarget, leafSource,
      headerTarget, headerChild, flatSource, crossTarget, crossSource,
      deepTarget, deepChild, deepSource, deepSourceChild,
      expenseTarget, expenseChild, expenseSource, ancSource, ancTarget, ancGrand,
      linedSource]);
  // A Sage-shaped chart: the leaves sit at level 1, so an ordinary merge lands a
  // real balance on a CHILDLESS level-1 target and must still run.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K051-2000','K051 Sage cashbook (level 1 leaf)','asset','debit',1,true,NULL),
            ($3,$2,'K051-2050','K051 Sage petty cash','asset','debit',3,true,NULL)`,
    [sageTarget, company, sageSource]);
  // The expense journal below gives the company a non-zero current-year result,
  // and `balanceSheetService` then resolves the retained-earnings role.
  await pool.query(
    "UPDATE gl_accounts SET account_subtype='retained_earnings', is_system_account=true WHERE id=$1 AND company_id=$2",
    [equity, company]);
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
  // Money on the sources whose merges are ADMITTED, so the positive path proves
  // where a real balance lands rather than repointing an empty account.
  await postJournal('K051-JE-LEAF', [[leafSource, 300, 0], [equity, 0, 300]]);
  await postJournal('K051-JE-DEEP', [[deepSource, 250, 0], [equity, 0, 250]]);
  await postJournal('K051-JE-PETTY', [[linedSource, 75, 0], [equity, 0, 75]]);
  await postJournal('K051-JE-EXPENSE', [[expenseSource, 90, 0], [equity, 0, 90]]);
  // crossSource needs a balance, or the guard's harmless-source exemption
  // returns before the cross-tenant child read the test below is about.
  await postJournal('K051-JE-CROSS', [[crossSource, 40, 0], [equity, 0, 40]]);
  await postJournal('K051-JE-SAGE', [[sageSource, 120, 0], [equity, 0, 120]]);
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

/** 500 + 1000 + 300 leaf + 250 deep + 75 lined + 40 cross + 120 sage. */
const OPENING_ASSETS = 2285;

it('refuses a merge that would turn the target into a header account', async () => {
  expect(await assetsOnBalanceSheet()).toBeCloseTo(OPENING_ASSETS, 2);

  await expect(runMerge(source, target)).rejects.toMatchObject({ code: 'target_becomes_header' });

  // Nothing moved: both accounts still carry their own balance on the report.
  expect(await assetsOnBalanceSheet()).toBeCloseTo(OPENING_ASSETS, 2);
  const { rows } = await pool.query(
    'SELECT parent_account_id, is_active FROM gl_accounts WHERE id=$1 AND company_id=$2',
    [child, company]);
  expect(rows[0].parent_account_id).toBe(source);
});

it('refuses an ALREADY-header level-2 target when the source carries lines to move', async () => {
  const before = await assetsOnBalanceSheet();
  await expect(runMerge(linedSource, headerTarget))
    .rejects.toMatchObject({ code: 'target_becomes_header' });
  // The R75 is still on the report, on the account it was posted to.
  expect(await assetLine('K051-1800')).toBeCloseTo(75, 2);
  expect(await assetsOnBalanceSheet()).toBeCloseTo(before, 2);
});

it('admits an ALREADY-header target from a source with neither children nor lines', async () => {
  // Nothing that was visible becomes invisible: the target was already off both
  // reports and the source brings no balance and no child to reparent onto it.
  const before = await assetsOnBalanceSheet();
  const result = await runMerge(flatSource, headerTarget);
  expect(result.sourceDeactivated).toBe(true);
  expect(await assetsOnBalanceSheet()).toBeCloseTo(before, 2);
});

it('merges a real balance into a leaf target, and it lands on the target line', async () => {
  const before = await assetsOnBalanceSheet();
  expect(await assetLine('K051-1250')).toBeCloseTo(300, 2);
  expect(await assetLine('K051-1200')).toBeCloseTo(0, 2);

  const result = await runMerge(leafSource, leafTarget);
  expect(result.sourceDeactivated).toBe(true);

  // The R300 moved rather than vanished: off the source, onto the target, and
  // total assets identical because a repoint posts no debit and no credit.
  expect(await assetLine('K051-1250')).toBeCloseTo(0, 2);
  expect(await assetLine('K051-1200')).toBeCloseTo(300, 2);
  expect(await assetsOnBalanceSheet()).toBeCloseTo(before, 2);
});

it('admits a level-3 target that HAS children, from a source that has children too', async () => {
  // The one shape that separates this guard from a blanket "no target with
  // children": at level 3 both reports select the account regardless, so the
  // reparent costs nothing and ordinary chart maintenance must still run.
  const before = await assetsOnBalanceSheet();
  const result = await runMerge(deepSource, deepTarget);
  expect(result.targetAccountCode).toBe('K051-1600');
  expect(await assetLine('K051-1600')).toBeCloseTo(250, 2);
  expect(await assetsOnBalanceSheet()).toBeCloseTo(before, 2);
  const { rows } = await pool.query(
    'SELECT parent_account_id FROM gl_accounts WHERE id=$1 AND company_id=$2',
    [deepSourceChild, company]);
  expect(rows[0].parent_account_id).toBe(deepTarget);
});

it('admits a level-2 EXPENSE header target — the income statement has no level filter', async () => {
  const result = await runMerge(expenseSource, expenseTarget);
  expect(result.targetAccountCode).toBe('K051-6000');
  // The balance sheet never carried an expense account, so nothing left it.
  expect(await assetsOnBalanceSheet()).toBeCloseTo(OPENING_ASSETS, 2);
});

it('reports the CYCLE, not the header rule, when the target descends from the source', async () => {
  await expect(runMerge(ancSource, ancTarget))
    .rejects.toMatchObject({ code: 'target_is_descendant_of_source' });
});

it('merges a Sage level-1 leaf target — a childless target loses nothing', async () => {
  // The shape `isReportVisibleLeaf`'s docstring promises keeps working: the
  // target is level 1 and CHILDLESS, so both reports still select it and the
  // R120 lands there. Without this the branch that admits it is unexecuted.
  const before = await assetsOnBalanceSheet();
  const result = await runMerge(sageSource, sageTarget);
  expect(result.sourceDeactivated).toBe(true);
  expect(await assetLine('K051-2000')).toBeCloseTo(120, 2);
  expect(await assetLine('K051-2050')).toBeCloseTo(0, 2);
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
