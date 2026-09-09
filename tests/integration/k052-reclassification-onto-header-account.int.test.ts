/**
 * K-052 — reclassification admits a target that is a parent HEADER account.
 *
 * admitReclassification (reclassification/planGuards.ts:84-160) checks
 * ownership, activity, the posting date's period, the VAT201 subtypes and the
 * VAT lock, but never asks whether the target is a leaf. Nothing downstream asks
 * either — `level` and `parent_account_id` appear nowhere in
 * src/modules/accounting/services/gl/reclassification/. balanceSheetService.ts:120-128
 * selects an account only when `level >= 3 OR it has no children`, so lines
 * moved onto a level <= 2 account that has children leave the balance sheet.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { admitReclassification } from '../../src/modules/accounting/services/gl/reclassification/planGuards';
import { isRefusal } from '../../src/modules/accounting/services/gl/reclassification/planGuards';
import { getBalanceSheet } from '../../src/modules/accounting/services/reports/balanceSheetService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const header = crypto.randomUUID(), headerChild = crypto.randomUUID();
const source = crypto.randomUUID(), equity = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const flatLeaf = crypto.randomUUID(), foreignChild = crypto.randomUUID();
const AS_AT = '2026-03-31';

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K052 reclass fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K052-1100','K052 Receivables (header)','asset','debit',2,true,NULL),
            ($3,$2,'K052-1110','K052 Receivables detail','asset','debit',3,true,$1),
            ($4,$2,'K052-1200','K052 Prepayments','asset','debit',3,true,NULL),
            ($5,$2,'K052-3000','K052 Retained earnings','equity','credit',3,true,NULL),
            ($6,$2,'K052-1300','K052 Loans (level 1 leaf)','asset','debit',1,true,NULL)`,
    [header, company, headerChild, source, equity, flatLeaf]);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K052 other tenant')", [otherCompany]);
  // Another tenant's child under this company's level-1 leaf must not make it a header.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K052-9900','K052 foreign child','asset','debit',3,true,$3)`,
    [foreignChild, otherCompany, flatLeaf]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K052 Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`, [company]);

  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,posted_at)
     VALUES($1,'K052-JE-1','2026-03-15'::date,'K052 opening','manual','posted',$2,NOW()) RETURNING id`, [company, user]);
  for (const [account, debit, credit] of [[header, 400, 0], [source, 1000, 0], [equity, 0, 1400]] as [string, number, number][]) {
    await pool.query(
      'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
      [rows[0].id, account, debit, credit, company]);
  }
});

afterAll(async () => {
  try {
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

it('the balance sheet already ignores a level-2 account that has children', async () => {
  // Supporting fact, not the defect: R400 sits on the header and never appears.
  const bs = await getBalanceSheet(company, AS_AT);
  expect(bs.totalAssets).toBeCloseTo(1000, 2);
});

it('refuses a reclassification whose target is a parent header account', async () => {
  const admitted = await admitReclassification({
    companyId: company,
    sourceAccountId: source,
    targetAccountId: header,
    from: null, to: null, postingDate: '2026-03-31',
  });
  expect(isRefusal(admitted)).toBe(true);
});

it('admits an ordinary level-3 leaf target', async () => {
  const admitted = await admitReclassification({
    companyId: company,
    sourceAccountId: header,
    targetAccountId: source,
    from: null, to: null, postingDate: '2026-03-31',
  });
  expect(isRefusal(admitted)).toBe(false);
});

it("admits a level-1 leaf target, ignoring another tenant's child under it", async () => {
  const admitted = await admitReclassification({
    companyId: company,
    sourceAccountId: source,
    targetAccountId: flatLeaf,
    from: null, to: null, postingDate: '2026-03-31',
  });
  expect(isRefusal(admitted)).toBe(false);
});

it('refuses the header target for the other tenant too, and never leaks its existence', async () => {
  const admitted = await admitReclassification({
    companyId: otherCompany,
    sourceAccountId: source,
    targetAccountId: header,
    from: null, to: null, postingDate: '2026-03-31',
  });
  expect(admitted).toEqual({ refused: 'NOT_FOUND' });
});
