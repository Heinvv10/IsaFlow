/**
 * cash13 PR 1, real PostgreSQL through the real route (withAuth, app_user, RLS): every source reaches the
 * forecast with the ruling's dates, one company never sees another's documents, and the weekly roll holds.
 * Dates are relative to the app's today (the route reads appToday()). Synthetic rows only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import cashForecastRoute from '../../pages/api/accounting/cash-forecast-13';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { appToday } from '@/modules/accounting/services/reports/dueByDateService';
import { addDaysISO } from '@/lib/dateUtils';
import { clearRateLimitCache } from '@/lib/rateLimit';
import type { CashForecast13 } from '@/modules/accounting/services/cashForecast13/types';
import { previousBusinessDay } from '@/modules/bureau/services/vatPeriodHelper';
import { buildWeeks, weekIndexOf } from '@/modules/accounting/services/cashForecast13/weeks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, dataOf, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetThreeWayFixture(pool);
const today = appToday();
const day = (n: number) => addDaysISO(today, n);
const pad = (n: number) => String(n).padStart(2, '0');
const prevMonth = (() => { const [y, m] = today.split('-').map(Number) as [number, number]; return m === 1 ? [y - 1, 12] : [y, m - 1]; })();

let A: ThreeWayCo;
let B: ThreeWayCo;
let C: ThreeWayCo;
const ids = { hist: crypto.randomUUID(), nohist: crypto.randomUUID(), other: crypto.randomUUID(), sup: crypto.randomUUID(), credit: crypto.randomUUID() };
const docs: Record<string, string> = {};

async function customer(c: ThreeWayCo, id: string, name: string) {
  await pool.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [id, c.id, name]);
}
async function invoice(c: ThreeWayCo, cust: string, no: string, due: string, total: number, paid = 0): Promise<string> {
  return String((await pool.query(
    `INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [c.id, cust, no, addDaysISO(due, -30), due, paid >= total ? 'paid' : 'approved', total, paid, c.user])).rows[0].id);
}
/** A paid invoice, settled by a receipt dated `late` days after its due date. */
async function paidInvoice(c: ThreeWayCo, cust: string, no: string, due: string, late: number, status = 'confirmed') {
  const inv = await invoice(c, cust, no, due, 100, 100);
  const pay = String((await pool.query(
    `INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
     VALUES ($1, $2, $3, $4, 100, $5, $6, $7) RETURNING id`, [c.id, cust, `RC-${no}`, addDaysISO(due, late), status, c.acct.bank, c.user])).rows[0].id);
  await pool.query(`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 100)`, [pay, inv]);
}

const call = async (c: ThreeWayCo): Promise<RouteOut> => fx.call(cashForecastRoute, '/api/accounting/cash-forecast-13', c.owner, 'GET');
const line = (f: CashForecast13, key: string) => f.lines.find((l) => l.key === key);

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company({ flag: false });
  C = await fx.company();
  // C: a primary version for each year the fixture carries past today, budgeting sales every month.
  for (const [fy, first] of [[2027, '2026-03'], [2028, '2027-03']] as const) {
    const v = await fx.version(C, { fy, kind: 'original', primary: true });
    await fx.amounts(C, v, C.acct.sales, monthsFrom(first), 50_000);
  }
  // C: a run for last month and that month's EMP201 marked filed — a completed item is not a payment to come.
  await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_net, total_paye, total_uif, total_sdl, approved_at)
     VALUES ($1, $2, $3, 'approved', 9000, 1500, 200, 100, clock_timestamp())`, [C.id, prevMonth[0], prevMonth[1]]);
  // C: a weekly regular run this month, the latest run — never used as the monthly net, warned (review L3).
  const twoBack = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_net, pay_frequency, period_start, period_end, approved_at)
     VALUES ($1, $2, $3, 'approved', 1, 'weekly', make_date($2, $3, 1), make_date($2, $3, 7), clock_timestamp())`, [C.id, twoBack[0], twoBack[1]]);
  const mark = await pool.connect();
  try {
    await mark.query('BEGIN');
    await mark.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: C.user, role: 'authenticated' })]);
    await mark.query(
      `INSERT INTO sars_compliance_events (company_id, event_type, due_date, description, status, period_start, period_end)
       VALUES ($1, 'EMP201_DUE', $2, 'EMP201 filed', 'completed', $3, (date_trunc('month', $3::date) + interval '1 month - 1 day')::date)`,
      [C.id, `${today.slice(0, 7)}-07`, `${prevMonth[0]}-${pad(prevMonth[1]!)}-01`]);
    await mark.query('COMMIT');
  } finally { mark.release(); }
  await fx.journal(A, day(-60), [{ acct: A.capital, credit: 10_000 }]); // bank debit R10 000
  await customer(A, ids.hist, 'History Ltd');
  await customer(A, ids.nohist, 'New Ltd');
  await customer(B, ids.other, 'Other tenant Ltd');
  // History Ltd: 3 receipts 10, 20, 30 days late → median 20.
  await paidInvoice(A, ids.hist, 'H1', day(-200), 10);
  await paidInvoice(A, ids.hist, 'H2', day(-150), 30);
  await paidInvoice(A, ids.hist, 'H3', day(-100), 20);
  docs.histOverdue = await invoice(A, ids.hist, 'H4', day(-40), 500);
  // New Ltd: 2 confirmed receipts, 1 cancelled, 1 paid 14 months ago → 2 count, no history.
  await paidInvoice(A, ids.nohist, 'N1', day(-90), 5);
  await paidInvoice(A, ids.nohist, 'N2', day(-60), 5);
  await paidInvoice(A, ids.nohist, 'N3', day(-50), 5, 'cancelled');
  await paidInvoice(A, ids.nohist, 'N4', day(-440), 5);
  docs.nohistOverdue = await invoice(A, ids.nohist, 'N5', day(-10), 300);
  docs.notDue = await invoice(A, ids.nohist, 'N6', day(10), 200);
  docs.otherTenant = await invoice(B, ids.other, 'X1', day(-5), 999);
  // Credit Ltd: a R100 000 invoice and an unallocated R40 000 receipt → R60 000 expected (review M2).
  await customer(A, ids.credit, 'Credit Ltd');
  docs.creditInv = await invoice(A, ids.credit, 'CR1', day(5), 100_000);
  await pool.query(
    `INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
     VALUES ($1, $2, 'RC-ONACC', $3, 40000, 'confirmed', $4, $5)`, [A.id, ids.credit, day(-3), A.acct.bank, A.user]);
  // Foreign invoices (review L6): USD at its stored 18.5; one with no stored rate is left out and warned.
  await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [A.id]);
  docs.usd = await invoice(A, ids.credit, 'USD1', day(8), 100);
  await pool.query(`UPDATE customer_invoices SET currency_code = 'USD', exchange_rate = 18.5 WHERE id = $1`, [docs.usd]);
  docs.eur = await invoice(A, ids.credit, 'EUR1', day(8), 70);
  await pool.query(`UPDATE customer_invoices SET currency_code = 'EUR', exchange_rate = NULL WHERE id = $1`, [docs.eur]);
  await pool.query(`INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, 'Supplier Ltd')`, [ids.sup, A.id]);
  docs.bill = String((await pool.query(
    `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1, $2, 'B1', $3, $4, 'approved', 400, 0, $5) RETURNING id`, [A.id, ids.sup, day(-45), day(-15), A.user])).rows[0].id);
  await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_net, total_paye, total_uif, total_sdl, approved_at)
     VALUES ($1, $2, $3, 'approved', 9000, 1500, 200, 100, clock_timestamp())`, [A.id, prevMonth[0], prevMonth[1]]);
  await pool.query(
    `INSERT INTO recurring_invoices (company_id, template_name, client_id, frequency, next_run_date, total_amount, subtotal, created_by)
     VALUES ($1, 'Retainer', $2, 'weekly', $3, 1150, 1150, $4)`, [A.id, ids.hist, day(2), A.user]);
  await pool.query(
    `INSERT INTO loans (company_id, principal, start_date, term_months, rate_mode, fixed_rate, reference)
     VALUES ($1, 120000, $2, 60, 'FIXED', 10, 'C13-LOAN')`, [A.id, `${today.slice(0, 7)}-01`]);
}, 120000);

afterAll(async () => {
  try {
    const cos = [A.id, B.id, C.id];
    await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM sars_compliance_events WHERE company_id = ANY($1)', [cos]);
    for (const t of ['customer_payments', 'customer_invoices', 'supplier_invoices', 'suppliers', 'recurring_invoices', 'customers', 'payroll_run_headers', 'loans']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [cos]);
    }
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1)', [cos.map((c) => `report:cash-forecast-13:co:${c}`)]);
    clearRateLimitCache();
    await fx.cleanup();
  } finally { await pool.end(); }
});

describe('GET /api/accounting/cash-forecast-13', () => {
  let f: CashForecast13;
  beforeAll(async () => {
    const r = await call(A);
    expect(r.status, JSON.stringify(r.body).slice(0, 500)).toBe(200);
    f = dataOf<CashForecast13>(r);
  }, 120000);

  it('rolls 13 weeks from opening cash: opening + Σ lines = closing, next opening = closing', async () => {
    const opening = await fx.direct(A, () => getCashBalance(A.id, today));
    expect(f.weeks).toHaveLength(13);
    expect(f.weeks[0]!.openingCents).toBe(Math.round(opening.total * 100));
    expect(f.weeks[0]!.openingCents).toBe(1_000_000);
    let prev = f.weeks[0]!.openingCents;
    for (const w of f.weeks) {
      expect(w.openingCents).toBe(prev);
      expect(w.closingCents).toBe(w.openingCents + f.lines.reduce((t, l) => t + l.weekly[w.index]!, 0));
      prev = w.closingCents;
    }
  });

  it('overdue AR with 3 paid invoices: due + median 20 days, basis history', () => {
    const l = line(f, `ar:${ids.hist}`)!;
    expect(l.basisCents).toEqual({ due: 0, history: 50_000, no_history: 0 });
    expect(l.items).toEqual([expect.objectContaining({ ref: docs.histOverdue, date: day(-20), weekIndex: 0, amountCents: 50_000, basis: 'history' })]);
  });

  it('overdue AR with 2 paid (a cancelled receipt and one older than 12 months do not count): week 1, no_history', () => {
    // One line per customer: New Ltd's overdue (no_history) and not-yet-due invoices share ar:<id>.
    const l = line(f, `ar:${ids.nohist}`)!;
    expect(l.flags).toContain('no_history');
    expect(l.basisCents).toEqual({ due: 20_000, history: 0, no_history: 30_000 });
    expect(l.items.find((i) => i.ref === docs.nohistOverdue)).toMatchObject({ date: today, weekIndex: 0, amountCents: 30_000, basis: 'no_history' });
    expect(f.lines.filter((x) => x.key.startsWith(`ar:${ids.nohist}`)).map((x) => x.key)).toEqual([`ar:${ids.nohist}`]);
    expect(f.overdueAR).toMatchObject({ totalCents: 80_000, invoiceCount: 2, byBasis: { history: 50_000, no_history: 30_000 } });
  });

  it('AR not yet due on its due date; overdue AP in week 1; another tenant’s invoice nowhere', () => {
    const weeks = buildWeeks(today);
    expect(line(f, `ar:${ids.nohist}`)!.items.find((i) => i.ref === docs.notDue)).toMatchObject({ ref: docs.notDue, weekIndex: weekIndexOf(day(10), today, weeks), amountCents: 20_000 });
    expect(line(f, `ap:${ids.sup}`)!.items[0]).toMatchObject({ ref: docs.bill, weekIndex: 0, amountCents: -40_000 });
    expect(JSON.stringify(f)).not.toContain(docs.otherTenant!);
    expect(JSON.stringify(f)).not.toContain(ids.other);
  });

  it('payroll, EMP201, loan and recurring lines come from their sources', () => {
    const pay = line(f, 'payroll:net')!;
    expect(pay.items.length).toBeGreaterThanOrEqual(2);
    for (const i of pay.items) expect(i.amountCents).toBe(-900_000);
    const emp = line(f, 'sars:emp201')!;
    expect(emp.items.length).toBeGreaterThan(0);
    // A month after the latest run is that run's PAYE − ETI + UIF + SDL (R1 800), an estimate.
    expect(emp.items.some((i) => i.amountCents === -180_000)).toBe(true);
    // Last month's EMP201 is pending here. Due before today it is assumed paid (review H1): listed, not forecast;
    // due today or later it is forecast at its run's declaration (R1 800).
    const prevRef = `EMP201:${prevMonth[0]}-${pad(prevMonth[1]!)}-01`;
    const prevDue = previousBusinessDay(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 7);
    if (prevDue < today) {
      expect(emp.items.map((i) => i.ref)).not.toContain(prevRef);
      expect(f.warnings.find((w) => w.code === 'sars_past_due_assumed_paid')?.message).toContain(`EMP201 ${prevMonth[0]}-${pad(prevMonth[1]!)}-01`);
    } else {
      expect(emp.items.find((i) => i.ref === prevRef)?.amountCents).toBe(-180_000);
    }
    expect(f.warnings.some((w) => w.code === 'loan_payments_not_recorded')).toBe(true);
    const rec = f.lines.find((l) => l.key.startsWith('recurring:'))!;
    expect(rec.category).toBe('customer_receipts');
    for (const i of rec.items) expect(i.amountCents).toBe(115_000);
    const loan = f.lines.find((l) => l.key.startsWith('loan:'))!;
    expect(loan.category).toBe('loans');
    expect(loan.totalCents).toBeLessThan(0);
  });

  it('a company without the budget flag gets no budget lines and says so', async () => {
    const r = await call(B);
    expect(r.status).toBe(200);
    const g = dataOf<CashForecast13>(r);
    expect(g.lines.some((l) => l.key.startsWith('budget:'))).toBe(false);
    expect(g.warnings.some((w) => w.code === 'budget_flag_off')).toBe(true);
    expect(g.lines.flatMap((l) => l.items).map((i) => i.ref)).toContain(docs.otherTenant);
  });

  it('with the flag on and no primary version: no budget lines, flagged', () => {
    expect(f.lines.some((l) => l.key.startsWith('budget:'))).toBe(false);
    expect(f.warnings.some((w) => w.code === 'budget_no_primary')).toBe(true);
  });

  it('a primary budget fills receipts as an estimate line', async () => {
    const r = await call(C);
    expect(r.status, JSON.stringify(r.body).slice(0, 500)).toBe(200);
    const g = dataOf<CashForecast13>(r);
    expect(g.warnings.filter((w) => w.source === 'budget')).toEqual([]);
    const b = line(g, 'budget:customer_receipts')!;
    expect(b).toMatchObject({ kind: 'estimate', category: 'customer_receipts' });
    expect(b.totalCents).toBeGreaterThan(0);
    // Last month's EMP201 was marked filed: not a payment to come. This month's still is.
    const refs = (line(g, 'sars:emp201')?.items ?? []).map((i) => i.ref);
    expect(refs).not.toContain(`EMP201:${prevMonth[0]}-${pad(prevMonth[1]!)}-01`);
    expect(refs).toContain(`EMP201:${today.slice(0, 7)}-01`);
    expect(g.warnings.some((w) => w.code === 'payroll_frequency_unsupported')).toBe(true);
    for (const i of line(g, 'payroll:net')!.items) expect(i.amountCents).toBe(-900_000);
  });

  it('nets a customer’s unapplied receipt off its invoice (R100k − R40k = R60k)', () => {
    const items = f.lines.flatMap((l) => l.items);
    expect(items.find((i) => i.ref === docs.creditInv)?.amountCents).toBe(6_000_000);
  });

  it('converts a foreign invoice at its stored rate; leaves out one with no rate, warned', () => {
    const items = f.lines.flatMap((l) => l.items);
    expect(items.find((i) => i.ref === docs.usd)?.amountCents).toBe(185_000);
    expect(items.map((i) => i.ref)).not.toContain(docs.eur);
    expect(f.warnings.find((w) => w.code === 'currency_not_converted')?.message).toContain('1 in EUR (70.00 EUR)');
  });

  it('refuses a write method', async () => {
    const r = await fx.call(cashForecastRoute, '/api/accounting/cash-forecast-13', A.owner, 'POST', {}, {});
    expect(r.status).toBe(405);
  });
});
