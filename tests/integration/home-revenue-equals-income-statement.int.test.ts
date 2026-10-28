/**
 * Home's Revenue tile, Revenue MTD and profit tile are the income statement's own figures.
 *
 * Revenue-type accounts of the other_income band are Other income on the P&L and are not in its
 * Revenue line; Home summed every revenue-type account, so on Demo the hero read R 263 608.30
 * against a P&L Revenue of R 262 145.60 (+ R 1 462.70 other income). Both are compared here with
 * getIncomeStatement over the same range, with an other-income account in the fixture so
 * "both equal" cannot hold by the two being the same wrong sum.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { getDashboardKPIs } from '../../src/modules/accounting/services/reports/kpiDashboardService';
import { getIncomeStatement } from '../../src/modules/accounting/services/reports/incomeStatementService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const id = (): string => crypto.randomUUID();
const user = id();
const company = id();
const period = id();
const acct = { bank: id(), sales: id(), other: id(), rent: id() };
const TODAY = '2026-10-28';
const MONTH = ['2026-10-01', TODAY] as const;
const WINDOW = ['2025-10-01', TODAY] as const;

async function post(n: string, date: string, left: string, right: string, amount: number): Promise<void> {
  const entry = id();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'seed','manual','posted',$6,$6,now())`, [entry, company, n, date, period, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'seed',$5),($1,$3,0,$4,'seed',$5)`, [entry, left, right, amount, company]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `hrie-${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [company, 'Home revenue = P&L']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$5,'1000','Bank','asset','bank','debit',true,false),
           ($2,$5,'4000','Sales','revenue','sales','credit',true,false),
           ($3,$5,'4900','Other income','revenue','other_income','credit',true,false),
           ($4,$5,'5000','Rent','expense','operating_expense','debit',true,false)`,
    [acct.bank, acct.sales, acct.other, acct.rent, company]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'FY2026',1,2026,'2026-01-01','2026-12-31','open')`, [period, company]);
  clearSystemAccountCache(company);
  await post('S1', '2026-10-05', acct.bank, acct.sales, 1000.25);
  await post('O1', '2026-10-06', acct.bank, acct.other, 40.5);
  await post('S0', '2026-09-20', acct.bank, acct.sales, 200);
  await post('X1', '2026-10-07', acct.rent, acct.bank, 100);
}, 120000);

afterAll(async () => {
  try {
    clearSystemAccountCache(company);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id=$1', [period]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

describe('Home revenue figures equal the income statement over the same range', () => {
  it('the fixture has other income the statement keeps out of Revenue', async () => {
    const is = await getIncomeStatement(company, MONTH[0], MONTH[1]);
    expect(is.totalRevenue).toBeCloseTo(1000.25, 2);
    expect(is.totalOtherIncome).toBeCloseTo(40.5, 2);
  });

  it('Revenue MTD = the statement\'s Revenue for the month so far', async () => {
    const kpis = await getDashboardKPIs(company, WINDOW[0], WINDOW[1], TODAY);
    const is = await getIncomeStatement(company, MONTH[0], MONTH[1]);
    expect(kpis.revenueMtd).toBeCloseTo(is.totalRevenue, 2);
  });

  it('the Revenue tile = the statement\'s Revenue for its window, and profit is still net of every account', async () => {
    const kpis = await getDashboardKPIs(company, WINDOW[0], WINDOW[1], TODAY);
    const is = await getIncomeStatement(company, WINDOW[0], WINDOW[1]);
    expect(kpis.revenue.total).toBeCloseTo(is.totalRevenue, 2);
    expect(kpis.revenue.total).toBeCloseTo(1200.25, 2);
    expect(kpis.grossProfit.amount).toBeCloseTo(is.netProfit, 2);
  });
});
