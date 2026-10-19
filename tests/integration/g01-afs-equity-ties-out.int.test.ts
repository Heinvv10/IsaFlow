/**
 * G-01 review round 1: the AFS equity surfaces must keep tying out when the year-end close is
 * posted, reversed and re-posted.
 *
 * Every report skips the posted close (source 'year_end'), so the retained-earnings ACCOUNT carries
 * neither the close nor, for a company that never closed, any profit. Anything that reads posted
 * equity must therefore ADD the derived profit, as the balance sheet does: the Statement of
 * Financial Position (current and prior column), Note 12, the KPI equity behind debt-to-equity.
 * Asserted against the fixture's own arithmetic in four ledger states, so "equally wrong in all
 * four" cannot pass: never closed, closed, closed-reversed-reclosed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { seedDefaultTaxonomy } from '../../src/modules/accounting/services/afs/afsMappingService';
import { generateStatementOfFinancialPosition } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/balanceSheet';
import { generateNote12ShareCapital } from '../../src/modules/accounting/services/afs/noteGenerators/notes11to15';
import { getChangesInEquity } from '../../src/modules/accounting/services/afs/changesInEquityService';
import { fetchBalanceSnapshot } from '../../src/modules/accounting/services/afs/afsKpiService';
import { getBalanceSheet } from '../../src/modules/accounting/services/reports/balanceSheetService';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const company = crypto.randomUUID();
const id = () => crypto.randomUUID();
const acct = { bank: id(), loan: id(), capital: id(), retained: id(), revenue: id(), expense: id() };
const period = { p24: id(), p25: id() };

// FY2024 profit 400 (600 - 200); FY2025 profit 1050 (1750 - 700); a 5000 loan in FY2025.
const EXPECTED = {
  assets25: 16450, liabilities25: 5000, equity25: 11450,
  assets24: 10400, equity24: 10400,
};

async function post(n: string, date: string, p: string, left: string, right: string, amount: number) {
  const entry = id();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'seed','manual','posted',$6,$6,now())`, [entry, company, n, date, p, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'seed',$5),($1,$3,0,$4,'seed',$5)`, [entry, left, right, amount, company]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01afs-${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [company, 'G01 AFS tie-out']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$7,'1000','Bank','asset','bank','debit',true,false),
           ($2,$7,'2000','Loan','liability','bank_loan','credit',true,false),
           ($3,$7,'3000','Share capital','equity','share_capital','credit',true,false),
           ($4,$7,'3200','Retained Earnings','equity','retained_earnings','credit',true,true),
           ($5,$7,'4000','Sales','revenue','sales','credit',true,false),
           ($6,$7,'5000','Rent','expense','operating_expense','debit',true,false)`,
    [acct.bank, acct.loan, acct.capital, acct.retained, acct.revenue, acct.expense, company]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$3,'FY2024',1,2024,'2024-01-01','2024-12-31','closed'),($2,$3,'FY2025',1,2025,'2025-01-01','2025-12-31','closed')`,
    [period.p24, period.p25, company]);
  clearSystemAccountCache(company);
  await seedDefaultTaxonomy(company);
  await pool.query(
    `INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code)
     VALUES($1,$2,'BS035'),($1,$3,'BS054'),($1,$4,'BS043'),($1,$5,'BS045'),($1,$6,'IS002'),($1,$7,'IS166')`,
    [company, acct.bank, acct.loan, acct.capital, acct.retained, acct.revenue, acct.expense]);
  await post('CAP', '2024-01-02', period.p24, acct.bank, acct.capital, 10000);
  await post('S24', '2024-06-01', period.p24, acct.bank, acct.revenue, 600);
  await post('X24', '2024-07-01', period.p24, acct.expense, acct.bank, 200);
  await post('LOAN', '2025-02-01', period.p25, acct.bank, acct.loan, 5000);
  await post('S25', '2025-03-01', period.p25, acct.bank, acct.revenue, 1750);
  await post('X25', '2025-04-01', period.p25, acct.expense, acct.bank, 700);
}, 120000);

afterAll(async () => {
  try {
    clearSystemAccountCache(company);
    await pool.query('DELETE FROM afs_account_mappings WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM afs_statement_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function expectEquityTiesOut() {
  const sfp = await generateStatementOfFinancialPosition(company, 2025, 'ifrs_smes');
  const snap = sfp.dataSnapshot as { totalAssets: number; totalLiabilities: number; totalEquity: number;
    lines: Array<{ code: string; currentAmount: number; priorAmount: number }> };
  expect(snap.totalAssets).toBe(EXPECTED.assets25);
  expect(snap.totalLiabilities).toBe(EXPECTED.liabilities25);
  expect(snap.totalEquity).toBe(EXPECTED.equity25);
  expect(snap.totalAssets).toBe(snap.totalEquity + snap.totalLiabilities);
  const line = (code: string) => snap.lines.find((l) => l.code === code)!;
  // Prior column: assets and equity at 31 Dec 2024 (equity is credit-positive, so negative raw).
  expect(line('BS038').priorAmount).toBe(EXPECTED.assets24);
  expect(-line('BS048').priorAmount).toBe(EXPECTED.equity24);

  const soce = await getChangesInEquity(company, '2025-01-01', '2025-12-31');
  expect(soce.totalProfitForYear).toBe(1050);
  expect(soce.totalDividends).toBe(0);
  expect(soce.totalClosing).toBe(EXPECTED.equity25);

  const note = (await generateNote12ShareCapital(company, 2025)).dataSnapshot.shareCapital as Array<{ balance: unknown }>;
  expect(note.reduce((s, r) => s + Number(r.balance), 0)).toBe(EXPECTED.equity25);

  expect((await fetchBalanceSnapshot(company, '2025-12-31')).totalEquity).toBe(EXPECTED.equity25);
  expect((await fetchBalanceSnapshot(company, '2024-12-31')).totalEquity).toBe(EXPECTED.equity24);
  expect((await getBalanceSheet(company, '2025-12-31')).totalEquity).toBe(EXPECTED.equity25);
}

describe('G-01: AFS equity ties out whatever the ledger holds for the year-end close', () => {
  it('a company that never closed: the SFP, SOCE, Note 12 and KPI equity carry the accumulated profit', async () => {
    await expectEquityTiesOut();
  });

  it('after the close of both years', async () => {
    await closeFiscalYear(company, '2024', user);
    await closeFiscalYear(company, '2025', user);
    const posted = await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [company]);
    expect(posted.rows[0].n).toBe(2);
    await expectEquityTiesOut();
  });

  it('after the 2025 close is reversed and posted again', async () => {
    const first = await pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND entry_number='YE-2025'", [company]);
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE id=$1", [period.p25]);
    await reverseJournalEntry(company, first.rows[0].id, user);
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE id=$1", [period.p25]);
    await expectEquityTiesOut();
    const again = await closeFiscalYear(company, '2025', user) as { alreadyClosed: boolean };
    expect(again.alreadyClosed).toBe(false);
    await expectEquityTiesOut();
  }, 60000);
});
