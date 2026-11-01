/**
 * The P&L PDF, through the real route (withAuth, request transaction, RLS), read
 * back from the bytes with pdf.js: company A's PDF states A's revenue, gross
 * profit, net profit and disclosure amounts to the cent, and no account of B's.
 *
 * Both companies carry the same shape with different figures and names. B's own
 * PDF is read too, so "B's names are absent from A's" cannot pass on a fixture
 * that never prints them. Disposable schema fixture only; synthetic data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/income-statement-pdf';
import { getIncomeStatement } from '../../src/modules/accounting/services/reports/incomeStatementService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { incomeStatementScopeLabel } from '../../src/modules/accounting/services/reports/incomeStatementPdf';
import { fmtZAR } from '../../src/modules/accounting/services/core/pdfShared';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const id = (): string => crypto.randomUUID();
const QUERY = { period_start: '2026-04-01', period_end: '2026-04-30' };

interface Co { user: SetupUser; period: string; entries: string[] }
let a: Co;
let b: Co;

type Acct = [code: string, name: string, type: 'asset' | 'revenue' | 'expense', subtype: string, side: 'debit' | 'credit', amount: number];

async function seed(tag: string, accounts: Acct[]): Promise<Co> {
  const user = await newSetupUser(pool);
  const company = user.homeCompanyId;
  const period = id();
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'FY2026',1,2026,'2026-01-01','2026-12-31','open')`, [period, company]);
  const bank = id();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'1000',$3,'asset','bank','debit',true,false)`, [bank, company, `${tag} Bank`]);
  const entries: string[] = [];
  for (const [code, name, type, subtype, side, amount] of accounts) {
    const account = id();
    const entry = id();
    entries.push(entry);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
       VALUES($1,$2,$3,$4,$5,$6,$7,true,false)`, [account, company, code, name, type, subtype, side]);
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
       VALUES($1,$2,$3,'2026-04-15',$4,'seed','manual','posted',$5,$5,now())`, [entry, company, `P-${code}`, period, user.userId]);
    const [debit, credit] = side === 'debit' ? [account, bank] : [bank, account];
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,$4,0,'seed',$5),($1,$3,0,$4,'seed',$5)`, [entry, debit, credit, amount, company]);
  }
  clearSystemAccountCache(company);
  return { user, period, entries };
}

async function drop(co: Co): Promise<void> {
  const company = co.user.homeCompanyId;
  clearSystemAccountCache(company);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id=$1', [co.period]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.query('DELETE FROM users WHERE id=$1', [co.user.userId]);
}

async function pdfOf(user: SetupUser, query: Record<string, string> = QUERY): Promise<{ status: number; text: string; raw: unknown }> {
  const req = request({ 'sb-access-token': user.token, active_company_id: user.homeCompanyId }, 'GET') as unknown as
    { url: string; query: Record<string, string> };
  req.url = '/api/accounting/income-statement-pdf';
  req.query = query;
  const out = response();
  await (route as (x: never, y: never) => Promise<unknown>)(req as never, out.res as never);
  const body = out.state.body;
  if (!Buffer.isBuffer(body)) return { status: out.state.statusCode, text: '', raw: body };
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  const text = (await new PDFParse({ data: body }).getText()).text.replace(/\s+/g, ' ');
  return { status: out.state.statusCode, text, raw: null };
}

const cents = (amount: number): string => fmtZAR(amount).replace(/ /g, ' ');

beforeAll(async () => {
  a = await seed('ALPHA', [
    ['4000', 'ALPHA Fibre Sales', 'revenue', 'sales', 'credit', 150000.37],
    ['4100', 'ALPHA Unclassified Income', 'revenue', 'default_revenue', 'credit', 2500.11],
    ['4900', 'ALPHA Interest Received', 'revenue', 'other_income', 'credit', 410.59],
    ['5000', 'ALPHA Direct Materials', 'expense', 'cost_of_sales', 'debit', 60000.21],
    ['5500', 'ALPHA Unclassified Expense', 'expense', 'default_expense', 'debit', 7300.43],
    ['6000', 'ALPHA Office Rent', 'expense', 'operating_expense', 'debit', 21000.07],
    ['7000', 'ALPHA Bank Interest', 'expense', 'finance_cost', 'debit', 900.19],
  ]);
  b = await seed('BRAVO', [
    ['4000', 'BRAVO Secret Sales', 'revenue', 'sales', 'credit', 987654.32],
    ['5500', 'BRAVO Hidden Unclassified', 'expense', 'default_expense', 'debit', 12345.67],
    ['6000', 'BRAVO Private Rent', 'expense', 'operating_expense', 'debit', 4444.44],
  ]);
}, 120_000);

afterAll(async () => {
  try {
    await drop(a);
    await drop(b);
  } finally {
    await pool.end();
  }
});

describe('income-statement-pdf through the route', () => {
  it('states company A\'s figures to the cent, as the statement computes them', async () => {
    const report = await getIncomeStatement(a.user.homeCompanyId, QUERY.period_start, QUERY.period_end);
    expect(report.grossProfit).not.toBe(report.netProfit);
    expect(report.subtypeDisclosure).toBeTruthy();

    const { status, text } = await pdfOf(a.user);
    expect(status).toBe(200);
    for (const amount of [
      report.totalRevenue, report.totalCostOfSales, report.grossProfit, report.totalOtherIncome,
      report.totalOperatingExpenses, report.operatingProfit, report.totalOtherExpenses, report.netProfit,
    ]) expect(text).toContain(cents(amount));
    // Label beside figure, as the fixture alone decides them, so this does not rest on the service it reads.
    for (const row of [
      'Total Turnover R 152,500.48', 'Total Cost of Sales R 60,000.21', 'Gross Profit R 92,500.27',
      'Total Other Income R 410.59', 'Total Operating Expenses R 28,300.50', 'Operating Profit R 64,610.36',
      'Total Other Expenses R 900.19', 'Net Profit R 63,710.17',
    ]) expect(text).toContain(row);
  });

  it('states the disclosure amounts, with the accounts named', async () => {
    const report = await getIncomeStatement(a.user.homeCompanyId, QUERY.period_start, QUERY.period_end);
    const { text } = await pdfOf(a.user);
    expect(text).toContain(`Expense that could be cost of sales (at most) ${cents(report.subtypeDisclosure!.costOfSalesExposureAtMost)}`);
    expect(text).toContain(`Revenue that could be other income (at most) ${cents(report.subtypeDisclosure!.otherIncomeExposureAtMost)}`);
    expect(text).toContain('ALPHA Unclassified Expense');
    expect(text).toContain('The amounts above are repeated elsewhere in this sheet — do not add them again.');
  });

  it('never prints company B\'s accounts or figures in A\'s PDF', async () => {
    const own = await pdfOf(b.user);
    for (const name of ['BRAVO Secret Sales', 'BRAVO Hidden Unclassified', 'BRAVO Private Rent']) expect(own.text).toContain(name);

    const { text } = await pdfOf(a.user);
    expect(text).not.toContain('BRAVO');
    expect(text).not.toContain('987,654.32');
    expect(text).toContain('ALPHA Fibre Sales');
  });

  it('prints a filter from another company as unknown, with nothing of that company', async () => {
    const cc = id();
    const bu = id();
    const owner = b.user.homeCompanyId;
    await pool.query(`INSERT INTO cost_centres(id,company_id,code,name) VALUES($1,$2,'BRAVO-CC','BRAVO Depot')`, [cc, owner]);
    await pool.query(`INSERT INTO business_units(id,company_id,code,name) VALUES($1,$2,'BRAVO-BU','BRAVO Division')`, [bu, owner]);
    try {
      const { status, text } = await pdfOf(a.user, { ...QUERY, cost_centre_id: cc, business_unit_id: bu });
      expect(status).toBe(200);
      expect(text).toContain('Cost centre: unknown');
      expect(text).not.toContain('BRAVO');
      // Outside a request there is no RLS, so these two answers are the predicate's own.
      expect(await incomeStatementScopeLabel(owner, cc, bu)).toBe('Cost centre: BRAVO-CC — BRAVO Depot · Business unit: BRAVO-BU — BRAVO Division');
      expect(await incomeStatementScopeLabel(a.user.homeCompanyId, cc, bu)).toBe('Cost centre: unknown · Business unit: unknown');
    } finally {
      await pool.query('DELETE FROM cost_centres WHERE id=$1', [cc]);
      await pool.query('DELETE FROM business_units WHERE id=$1', [bu]);
    }
  });
});
