/**
 * One definition per headline figure (app audit 12 Nov 2026, P2.5 item 1).
 *
 * /accounting (kpi-dashboard), /home (clientMetricsSnapshot + /api/home), the
 * "Today in the books" cards (getWorkbenchMetrics), the Action Items
 * (dashboard-todos) and Month-End (getMonthEndWorkbench) each read cash,
 * receivables, payables, revenue MTD and the draft / bill counts from
 * reports/headlineFigures, as at one SAST day. The fixture makes every OLD
 * definition disagree with the new one, so equal figures here cannot be the
 * screens agreeing on a wrong sum:
 *   cash: a future-dated and a draft bank journal (old /home counted the first,
 *     every reader must drop the second), a statement sum far from the ledger
 *     (old dashboard), an inactive bank account and a petty-cash account
 *     carrying balances (old /home dropped petty cash);
 *   receivables: an invoice dated after today (old /home and Month-End counted it);
 *   revenue MTD: other income and a sale dated after today (old /home counted
 *     both), a year-end closing journal and last month's sale;
 *   counts: a draft bill and a soft-deleted draft invoice (old "Draft invoices"),
 *     12 overdue bills (the Action Items row printed its 10-row cap), a draft, a
 *     paid and a soft-deleted bill due this week (old "AP due this week").
 * A second company carries its own invoice, journal and bill; no figure of the
 * first moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { todayInSast } from '@/lib/saDateParser';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { getHeadlineFigures } from '@/modules/accounting/services/reports/headlineFigures';
import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';
import { getWorkbenchMetrics } from '@/modules/accounting/services/dashboard/workbenchService';
import { getMonthEndWorkbench } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import kpiDashboardRoute from '../../pages/api/accounting/kpi-dashboard';
import homeRoute from '../../pages/api/home';
import todosRoute from '../../pages/api/accounting/dashboard-todos';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const id = (): string => crypto.randomUUID();
const USER = id();
const C = id();
const D = id();
const A = { bank: id(), bankOff: id(), petty: id(), oca: id(), capital: id(), sales: id(), other: id(), rent: id() };
const DA = { bank: id(), sales: id() };
const CUST = id();
const SUPP = id();
const D_CUST = id();
const D_SUPP = id();

const T = todayInSast();
/** YYYY-MM-DD `n` days from T, by calendar arithmetic in UTC (no host-zone drift). */
const add = (n: number): string => {
  const d = new Date(`${T}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const MONTH_START = `${T.slice(0, 8)}01`;
const PERIOD = T.slice(0, 7);
const PERIOD_END = (() => {
  const [y, m] = PERIOD.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
})();
const DAY_BEFORE_MONTH = (() => {
  const d = new Date(`${MONTH_START}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
})();

const EXPECTED = {
  asAt: T,
  monthStart: MONTH_START,
  cash: 1250, // 1000 bank (T-5) + 200 inactive bank + 50 petty cash
  receivables: { total: 1250, overdue: 1000 },
  payables: { total: 320, overdue: 120 },
  revenueMtd: 400,
  profitMtd: 340, // 400 turnover + 40 other income - 100 rent
  draftInvoices: 1,
  draftBills: 2,
  draftJournals: 2,
  billsDueNext7Days: 1,
  billsOverdue: 12,
};

let token = '';

async function journal(company: string, date: string, dr: string, cr: string, amount: number, opts: { status?: string; source?: string } = {}): Promise<void> {
  const entry = id();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,status,created_by)
     VALUES($1,$2,$3,'kpi fixture',$4,$5,$6)`,
    [entry, company, date, opts.source ?? 'manual', opts.status ?? 'posted', USER]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'kpi',$5),($1,$3,0,$4,'kpi',$5)`, [entry, dr, cr, amount, company]);
}

async function invoice(company: string, customer: string, n: string, invoiceDate: string, due: string, total: number,
  status = 'approved', deleted = false): Promise<void> {
  await pool.query(
    `INSERT INTO customer_invoices
       (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by, deleted_at)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,0,$8,$9)`,
    [company, customer, n, invoiceDate, due, status, total, USER, deleted ? new Date() : null]);
}

async function bill(company: string, supplier: string, n: string, due: string, total: number,
  opts: { status?: string; paid?: number; deleted?: boolean } = {}): Promise<void> {
  await pool.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [company, supplier, n, add(-40), due, opts.status ?? 'approved', total, opts.paid ?? 0, USER, opts.deleted ? new Date() : null]);
}

async function cleanup(): Promise<void> {
  const cos = [C, D];
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1::uuid[]))', [cos]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM customers WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM company_users WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM users WHERE id = $1', [USER]);
}

async function call<T>(route: unknown, company: string = C): Promise<T> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET');
  (req as unknown as { query: unknown }).query = {};
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: T }).data;
}

describeIfDb('headline figures: one definition across /accounting, /home and Month-End', () => {
  beforeAll(async () => {
    assertDisposable();
    await cleanup();
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [USER, `kpi-${USER}@test.local`]);
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [C, 'KPI one source', D, 'KPI other tenant']);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$3,'admin'),($2,$3,'admin')", [C, D, USER]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
       VALUES($1,$9,'1000','Bank','asset','bank','debit',true,false),
             ($2,$9,'1010','Old bank','asset','bank','debit',false,false),
             ($3,$9,'1050','Petty cash','asset','cash','debit',true,false),
             ($4,$9,'1400','Sundry','asset','other_current_asset','debit',true,false),
             ($5,$9,'3000','Capital','equity','share_capital','credit',true,false),
             ($6,$9,'4000','Sales','revenue','sales','credit',true,false),
             ($7,$9,'4900','Other income','revenue','other_income','credit',true,false),
             ($8,$9,'5000','Rent','expense','operating_expense','debit',true,false)`,
      [A.bank, A.bankOff, A.petty, A.oca, A.capital, A.sales, A.other, A.rent, C]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
       VALUES($1,$3,'1000','Bank','asset','bank','debit',true,false),($2,$3,'4000','Sales','revenue','sales','credit',true,false)`,
      [DA.bank, DA.sales, D]);
    clearSystemAccountCache(C);
    clearSystemAccountCache(D);

    // Cash.
    await journal(C, add(-5), A.bank, A.capital, 1000);
    await journal(C, add(5), A.bank, A.capital, 500); // dated after today
    await journal(C, T, A.bank, A.capital, 300, { status: 'draft' }); // draft, dated this month
    await journal(C, add(62), A.bank, A.capital, 70, { status: 'draft' }); // draft, two months ahead
    await journal(C, add(-3), A.bankOff, A.capital, 200);
    await journal(C, add(-3), A.petty, A.capital, 50);
    await pool.query(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,status)
       VALUES($1,$2,$3,99999,'reconciled')`, [C, A.bank, add(-5)]);
    // Revenue and profit.
    await journal(C, T, A.oca, A.sales, 400);
    await journal(C, T, A.oca, A.other, 40);
    await journal(C, add(1), A.oca, A.sales, 77); // after today
    await journal(C, T, A.rent, A.oca, 100);
    await journal(C, T, A.sales, A.capital, 1000, { source: 'year_end' });
    await journal(C, DAY_BEFORE_MONTH, A.oca, A.sales, 9); // last month

    // Receivables.
    await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)', [CUST, C, 'KPI customer', D_CUST, D, 'Other customer']);
    await invoice(C, CUST, 'KPI-1', add(-40), add(-10), 1000);
    await invoice(C, CUST, 'KPI-2', add(-5), add(3), 250);
    await invoice(C, CUST, 'KPI-3', add(2), add(30), 60); // dated after today
    await invoice(C, CUST, 'KPI-4', add(-5), add(25), 9000, 'draft');
    await invoice(C, CUST, 'KPI-5', add(-5), add(25), 9000, 'draft', true);

    // Payables.
    await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)', [SUPP, C, 'KPI supplier', D_SUPP, D, 'Other supplier']);
    for (let i = 1; i <= 12; i++) await bill(C, SUPP, `KPB-${i}`, add(-10 - i), 10);
    await bill(C, SUPP, 'KPB-13', add(3), 200);
    await bill(C, SUPP, 'KPB-14', add(3), 300, { status: 'draft' });
    await bill(C, SUPP, 'KPB-15', add(3), 400, { status: 'paid', paid: 400 });
    await bill(C, SUPP, 'KPB-16', add(3), 500, { deleted: true });
    await bill(C, SUPP, 'KPB-17', add(60), 600, { status: 'draft' });

    // The other tenant: an invoice, a posted journal, a draft journal and bills of its own.
    await invoice(D, D_CUST, 'D-1', add(-40), add(-10), 777);
    await invoice(D, D_CUST, 'D-2', add(-1), add(10), 777, 'draft');
    await journal(D, T, DA.bank, DA.sales, 777);
    await journal(D, T, DA.bank, DA.sales, 5, { status: 'draft' });
    await bill(D, D_SUPP, 'DB-1', add(-12), 777);
    await bill(D, D_SUPP, 'DB-2', add(2), 777);
    await bill(D, D_SUPP, 'DB-3', add(2), 777, { status: 'draft' });

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    try {
      clearSystemAccountCache(C);
      clearSystemAccountCache(D);
      await cleanup();
    } finally {
      await pool.end();
    }
  }, 60000);

  it('getHeadlineFigures equals the hand-computed set, and the other tenant changes none of it', async () => {
    expect(await getHeadlineFigures(C)).toEqual(EXPECTED);
  });

  it('the other tenant has figures of its own (so the line above is a real isolation check)', async () => {
    const d = await getHeadlineFigures(D);
    expect(d.cash).toBe(777);
    expect(d.receivables.total).toBe(777);
    expect(d.revenueMtd).toBe(777);
    expect(d.draftInvoices).toBe(1);
    expect(d.draftJournals).toBe(1);
    expect(d.billsOverdue).toBe(1);
    expect(d.billsDueNext7Days).toBe(1);
  });

  it('/accounting: kpi-dashboard returns the headline, and its own tiles agree with it', async () => {
    const data = await call<{
      headline: typeof EXPECTED;
      kpis: { receivables: { total: number }; revenueMtd: number };
      period: { from: string; to: string };
    }>(kpiDashboardRoute);
    expect(data.headline).toEqual(EXPECTED);
    expect(data.kpis.receivables.total).toBe(data.headline.receivables.total);
    expect(data.kpis.revenueMtd).toBe(data.headline.revenueMtd);
    expect(data.period.to).toBe(T);
  });

  it('/home and the bureau client home: clientMetricsSnapshot (no request context) is the headline', async () => {
    expect(await clientMetricsSnapshot(C)).toEqual({
      cash: EXPECTED.cash, ar: EXPECTED.receivables.total, ap: EXPECTED.payables.total,
      revenueMtd: EXPECTED.revenueMtd, profitMtd: EXPECTED.profitMtd, asAt: T,
    });
  });

  it('/api/home: the metric strip and "total owed" are the headline figures', async () => {
    const data = await call<{ metrics: { cash: number; ar: number }; cashPosition: { cash: number; arTotal: number } }>(homeRoute);
    expect(data.metrics.cash).toBe(EXPECTED.cash);
    expect(data.metrics.ar).toBe(EXPECTED.receivables.total);
    expect(data.cashPosition.cash).toBe(EXPECTED.cash);
    expect(data.cashPosition.arTotal).toBe(EXPECTED.receivables.total);
  });

  it('"Today in the books": draft invoices, bills due in 7 days and draft journals are the headline counts', async () => {
    const m = await getWorkbenchMetrics(C);
    expect(m.draftInvoices).toBe(EXPECTED.draftInvoices);
    expect(m.apDueThisWeek).toBe(EXPECTED.billsDueNext7Days);
    expect(m.unpostedJournals).toBe(EXPECTED.draftJournals);
  });

  it('Action Items: the overdue bill count is the true 12, beside its 10 listed rows', async () => {
    const data = await call<{ draftInvoices: number; overdueBillCount: number; pendingSupplierPayments: unknown[] }>(todosRoute);
    expect(data.draftInvoices).toBe(EXPECTED.draftInvoices);
    expect(data.overdueBillCount).toBe(12);
    expect(data.pendingSupplierPayments).toHaveLength(10);
  });

  it('Month-End, current period: the Sales, Supplier and Exceptions cards say the headline figures', async () => {
    const wb = await getMonthEndWorkbench(C, PERIOD);
    const card = (cardId: string) => wb.cards.find((c) => c.id === cardId)!;
    const asAt = formatDisplayDate(T);
    expect(card('sales').secondary).toBe(`${formatMoney(EXPECTED.receivables.total)} outstanding · 1 customers · as at ${asAt}`);
    expect(card('sales').primary).toBe(`${formatMoney(EXPECTED.receivables.overdue)} overdue`);
    expect(card('purchases').secondary).toBe(`${formatMoney(EXPECTED.payables.total)} outstanding · 1 suppliers · as at ${asAt}`);
    const exceptions = card('exceptions').secondary!;
    expect(exceptions).toContain(`${EXPECTED.draftInvoices} draft invoices`);
    expect(exceptions).toContain(`${EXPECTED.draftBills} draft bills`);
    // Period-bounded on purpose, and labelled: the draft dated two months ahead is not in it.
    expect(exceptions).toContain(`1 draft journals dated to ${formatDisplayDate(PERIOD_END)}`);
  });
});
