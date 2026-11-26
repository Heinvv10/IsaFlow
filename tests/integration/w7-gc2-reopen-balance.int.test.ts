/**
 * Wave 7 GC2, breaker round 2 on #1929 (G4, G5 ported; coordinator ruling): an order's balance counts what a CONFIRMED
 * salary bank file paid its creditor (1057 payroll_garnishee_order_counted: per run, the greater of the applied
 * deduction and the confirmed payment). A reopen keeps it; a same-amount re-approval counts it once. Invariant: the
 * creditor is never paid more than the order's total debt. A refused post in the judge -> post window answers 409 and
 * leaves no draft journal. Real routes, withAuth, app_user, RLS; disposable fixture (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import orders from '../../pages/api/payroll/employees/[id]/garnishee-orders/index';
import orderRoute from '../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';
import { todayInSast } from '@/lib/saDateParser';
import { rig, type Route } from './brkr.helpers';
import { act, bank, cleanup, enable, generate, payingAccount, reason, type R } from './payroll-bank-file.helpers';

let a: R;
let b: R;
const TODAY = todayInSast();
const BANK = { bankName: 'First National Bank', branchCode: '250655', accountNumber: '62001234567', accountType: 'cheque', accountHolder: 'Acme Credit Ltd' };

async function newOrder(employee: string, body: Record<string, unknown>): Promise<string> {
  const m = await a.call(orders as Route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders`, employee,
    { body: { kind: 'emolument_attachment', reference: 'EAO 4', creditorName: 'Acme Credit', priority: 10, endDate: null, ...body } });
  if (m.statusCode !== 201) throw new Error(JSON.stringify(m.body));
  const id = String(m.body.data!.id);
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId: id };
    return (orderRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  expect((await a.call(route, 'PUT', `/api/payroll/employees/${employee}/garnishee-orders/${id}`, employee, { body: BANK })).statusCode).toBe(200);
  return id;
}
const order = async (id: string) => (await a.pool.query(
  'SELECT status, balance::float8 AS balance, total_debt::float8 AS total_debt FROM payroll_garnishee_orders WHERE id = $1', [id])).rows[0]!;
const paid = async (id: string) => Number((await a.pool.query(
  `SELECT COALESCE(sum(i.amount_cents), 0)::float8 / 100 AS n FROM payroll_bank_file_items i JOIN payroll_bank_files f ON f.id = i.file_id
    WHERE i.garnishee_order_id = $1 AND f.status = 'confirmed'`, [id])).rows[0]!.n);
const deducted = async (run: string, id: string) => Number((await a.pool.query(
  'SELECT COALESCE(sum(amount), 0)::float8 AS n FROM payroll_garnishee_deductions WHERE run_id = $1 AND order_id = $2', [run, id])).rows[0]!.n);
const creditorJournals = async () => (await a.pool.query(
  "SELECT id, status FROM gl_journal_entries WHERE company_id = $1 AND description LIKE 'Garnishee creditors paid by salary bank file%'",
  [a.company])).rows;
const journalOf = async (run: string) => String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0]!.journal_entry_id);

/** Approve the month's run, generate and confirm its file. */
async function payMonth(m: number, y: number): Promise<{ run: string; file: string }> {
  const run = await a.calculatedRun(m, y);
  const ap = await a.api.approve(run);
  expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
  const g = await generate(a, run, { actionDate: TODAY });
  expect(g.statusCode, JSON.stringify(g.body)).toBe(200);
  const c = await act(a, run, String(g.body.data!.id), 'confirm', { body: {} });
  expect(c.statusCode, JSON.stringify(c.body)).toBe(200);
  return { run, file: String(g.body.data!.id) };
}

beforeAll(async () => {
  a = await rig('w7-gc2-reopen-balance');
  b = await rig('w7-gc2-reopen-balance-b');
  for (const r of [a, b]) { await r.setup(); await enable(r); await payingAccount(r); }
}, 120_000);
afterAll(async () => {
  const rigs = [a, b];
  for (const r of rigs.filter(Boolean)) { a = r; await clean(); }
}, 120_000);

async function clean(): Promise<void> {
  await a.pool.query('DROP TRIGGER IF EXISTS zz_gc2_close_on_creditor_je ON gl_journal_entries');
  await a.pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND status <> 'open'", [a.company]);
  await a.pool.query('DELETE FROM payroll_bank_file_items WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_bank_files WHERE company_id = $1', [a.company]);
  await a.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [a.company]);
  await a.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [a.company]);
  await cleanup(a);
}

describe('the balance keeps what a confirmed file paid', () => {
  it('confirm -> reopen -> same-amount re-approval, three months running: each month counts once; paid = debt', async () => {
    const emp = (await a.employee(200000)).employee;
    await bank(a, emp, '4071234568');
    const o = await newOrder(emp, { reference: 'EAO 5', instalment: 10000, totalDebt: 30000, startDate: '2026-01-01' });
    let month = 0;
    for (const [m, y] of [[3, 2026], [4, 2026], [5, 2026]] as const) {
      const { run } = await payMonth(m, y);
      month += 1;
      expect((await order(o)).balance).toBe(30000 - 10000 * month);
      expect((await a.api.reopen(run)).statusCode).toBe(200);
      expect((await order(o)).balance).toBe(30000 - 10000 * month); // kept at the reopen
      expect((await a.api.reverse(await journalOf(run))).statusCode).toBe(200);
      expect((await a.api.calculate(run)).statusCode).toBe(200);
      expect(await deducted(run, o)).toBe(10000); // the run's own confirmed payment is added back, even on the last instalment
      await a.authorise(run);
      expect((await a.api.approve(run)).statusCode).toBe(200);
      expect((await order(o)).balance).toBe(30000 - 10000 * month); // counted once, not twice
    }
    expect(await order(o)).toMatchObject({ balance: 0, status: 'satisfied' });
    expect(await paid(o)).toBe(30000);
    const jun = await a.calculatedRun(6, 2026);
    expect((await a.api.approve(jun)).statusCode).toBe(200);
    expect(await deducted(jun, o)).toBe(0);
  }, 300_000);

  it('G4: confirm Oct racing its reopen, Oct left reopened, Nov-Feb paid: the creditor is paid exactly the debt; Oct re-approves, counted once', async () => {
    const emp = (await a.employee(200000)).employee;
    await bank(a, emp, '4071234567');
    const o = await newOrder(emp, { instalment: 10000, totalDebt: 30000, startDate: '2026-01-01' });
    const oct = await a.calculatedRun(10, 2026);
    expect((await a.api.approve(oct)).statusCode).toBe(200);
    const g = await generate(a, oct, { actionDate: TODAY });
    const [c, ro] = await Promise.all([act(a, oct, String(g.body.data!.id), 'confirm', { body: {} }), a.api.reopen(oct)]);
    // Serialised on the run header: either the confirm went first (paid, and the reopen kept it) or the reopen did
    // (nothing applied, so the confirm is refused): never both "paid" and "given back".
    expect([200, 409]).toContain(c.statusCode);
    if (ro.statusCode !== 200) expect((await a.api.reopen(oct)).statusCode).toBe(200);
    const octPaid = await paid(o);
    expect(octPaid === 10000 ? c.statusCode : reason(c)).toBe(octPaid === 10000 ? 200 : 'CREDITOR_AMOUNT_DIFFERS');
    expect((await order(o)).balance).toBe(30000 - octPaid); // the reopen did not give the paid instalment back

    for (const [m, y] of [[11, 2026], [12, 2026], [1, 2027], [2, 2027]] as const) {
      const run = await a.calculatedRun(m, y);
      expect((await a.api.approve(run)).statusCode).toBe(200);
      if ((await deducted(run, o)) === 0) continue; // satisfied: nothing to pay
      const gg = await generate(a, run, { actionDate: TODAY });
      expect((await act(a, run, String(gg.body.data!.id), 'confirm', { body: {} })).statusCode).toBe(200);
    }
    expect(await paid(o)).toBe(30000);
    expect(await paid(o)).toBeLessThanOrEqual((await order(o)).total_debt);
    expect(await order(o)).toMatchObject({ balance: 0, status: 'satisfied' });

    // October, still reopened: recalculated, it deducts what its confirmed file paid (added back to the satisfied
    // order for this run only) and its re-approval counts it once. Had the confirm lost the race, Oct paid nothing and
    // the satisfied order deducts nil: either way the creditor stays paid exactly the debt.
    expect((await a.api.reverse(await journalOf(oct))).statusCode).toBe(200);
    expect((await a.api.calculate(oct)).statusCode).toBe(200);
    expect(await deducted(oct, o)).toBe(octPaid);
    await a.authorise(oct);
    const re = await a.api.approve(oct);
    expect(re.statusCode, JSON.stringify(re.body)).toBe(200);
    expect(await order(o)).toMatchObject({ balance: 0, status: 'satisfied' });
    expect(await paid(o)).toBe(30000);
  }, 300_000);

  it('N1: an order paid by a confirmed file, then ended with a date backdated before that month: the reopened run re-deducts exactly the paid amount and re-approves (tenant B)', async () => {
    const home = a;
    a = b;
    try {
      const emp = (await a.employee(200000)).employee;
      await bank(a, emp, '4071234560');
      const o = await newOrder(emp, { reference: 'EAO N1', instalment: 10000, totalDebt: 50000, startDate: '2026-01-01' });
      const { run } = await payMonth(7, 2026);
      expect(await paid(o)).toBe(10000);
      const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
        req.query = { ...req.query, orderId: o };
        return (orderRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
      }) as unknown as Route;
      const ended = await a.call(route, 'POST', `/api/payroll/employees/${emp}/garnishee-orders/${o}`, emp,
        { body: { endDate: '2026-01-31', reason: 'Court rescinded the order, backdated' } });
      expect(ended.statusCode, JSON.stringify(ended.body)).toBe(200);
      expect((await a.api.reopen(run)).statusCode).toBe(200);
      expect(await order(o)).toMatchObject({ status: 'ended', balance: 40000 }); // the reopen kept the paid R10 000
      expect((await a.api.reverse(await journalOf(run))).statusCode).toBe(200);
      expect((await a.api.calculate(run)).statusCode).toBe(200);
      expect(await deducted(run, o)).toBe(10000); // exactly what the bank paid, though the order no longer covers July
      await a.authorise(run);
      const re = await a.api.approve(run);
      expect(re.statusCode, JSON.stringify(re.body)).toBe(200);
      expect(await order(o)).toMatchObject({ status: 'ended', balance: 40000 }); // counted once
      expect(await paid(o)).toBe(10000);
    } finally { a = home; }
  }, 300_000);

  it('payroll_garnishee_order_counted: per run the GREATER of applied and confirmed-paid (applied only, paid only, equal, both differ); unapplied and unconfirmed never count', async () => {
    // Synthetic rows in a rolled-back transaction with guards and FK checks off (superuser; DDL rolls back): the
    // function alone, over shapes the routes can no longer produce together. CHECK constraints still hold.
    const c = await a.pool.connect();
    const id = () => crypto.randomUUID();
    const [co, order, emp] = [id(), id(), id()];
    const runs = Array.from({ length: 7 }, id);
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'"); // FK checks off
      // The guards are ENABLE ALWAYS (they fire under replica too): off for this rolled-back transaction only.
      for (const t of ['payroll_garnishee_deductions', 'payroll_bank_files', 'payroll_bank_file_items']) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      const deduction = (run: string, amount: number, applied: boolean) => c.query(
        `INSERT INTO payroll_garnishee_deductions (company_id, run_id, order_id, employee_id, requested, amount, balance_applied)
         VALUES ($1, $2, $3, $4, $5, $5, $6)`, [co, run, order, emp, amount, applied]);
      const paidBy = async (run: string, rands: number, status: 'confirmed' | 'generated') => {
        const file = id();
        await c.query(
          `INSERT INTO payroll_bank_files (id, company_id, run_id, layout, sha256, line_count, total_cents, action_date, run_approved_at, status,
             created_by, confirmed_by, confirmed_at)
           VALUES ($1, $2, $3, 'fnb_obe_2023_02', repeat('a', 64), 1, $4, '2026-11-25', now(), $5, 'u', CASE WHEN $5 = 'confirmed' THEN 'u' END,
                   CASE WHEN $5 = 'confirmed' THEN now() END)`, [file, co, run, rands * 100, status]);
        await c.query(
          `INSERT INTO payroll_bank_file_items (company_id, file_id, employee_id, amount_cents, garnishee_order_id, creditor_bank_name,
             creditor_branch_code, creditor_account_number, creditor_account_type, creditor_bank_set_at)
           VALUES ($1, $2, $3, $4, $5, 'FNB', '250655', '62001234567', 'cheque', now())`, [co, file, emp, rands * 100, order]);
      };
      await deduction(runs[0]!, 100, true); //                applied only            -> 100
      await paidBy(runs[1]!, 200, 'confirmed'); //            paid only (reopened)    -> 200
      await deduction(runs[2]!, 300, true); await paidBy(runs[2]!, 300, 'confirmed'); // equal -> 300 (once)
      await deduction(runs[3]!, 400, true); await paidBy(runs[3]!, 250, 'confirmed'); // differ -> 400
      await deduction(runs[4]!, 50, true); await paidBy(runs[4]!, 80, 'confirmed'); //  differ -> 80
      await deduction(runs[5]!, 999, false); //               not applied             -> 0
      await paidBy(runs[6]!, 500, 'generated'); //            not confirmed           -> 0
      const counted = Number((await c.query('SELECT public.payroll_garnishee_order_counted($1)::float8 AS n', [order])).rows[0]!.n);
      expect(counted).toBe(100 + 200 + 300 + 400 + 80);
      expect(Number((await c.query('SELECT public.payroll_garnishee_order_counted($1)::float8 AS n', [id()])).rows[0]!.n)).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }, 60_000);

  it('G5: a period closed in the judge -> post window answers 409 PERIOD_CLOSED and leaves no draft journal (tenant B)', async () => {
    const home = a;
    a = b; // the helpers act on `a`; B has its own months
    try {
    const emp = (await a.employee(200000)).employee;
    await bank(a, emp, '4071234569');
    await newOrder(emp, { reference: 'EAO 6', creditorName: 'Beta', instalment: 1000, totalDebt: 30000, startDate: '2026-01-01' });
    const run = await a.calculatedRun(8, 2026);
    expect((await a.api.approve(run)).statusCode).toBe(200);
    const g = await generate(a, run, { actionDate: TODAY });
    expect(g.statusCode, JSON.stringify(g.body)).toBe(200);
    // A trigger closes the action date's period as the creditor journal's draft is inserted (after the judge passed).
    await a.pool.query(`CREATE OR REPLACE FUNCTION public.zz_gc2_close_on_creditor_je() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.description LIKE 'Garnishee creditors paid%' THEN
        UPDATE fiscal_periods SET status = 'closed' WHERE company_id = NEW.company_id AND start_date <= NEW.entry_date AND end_date >= NEW.entry_date;
      END IF; RETURN NEW; END $$`);
    await a.pool.query('CREATE TRIGGER zz_gc2_close_on_creditor_je AFTER INSERT ON gl_journal_entries FOR EACH ROW EXECUTE FUNCTION public.zz_gc2_close_on_creditor_je()');
    const before = await creditorJournals();
    try {
      const c = await act(a, run, String(g.body.data!.id), 'confirm', { body: {} });
      expect([c.statusCode, reason(c)], JSON.stringify(c.body)).toEqual([409, 'PERIOD_CLOSED']);
    } finally {
      await a.pool.query('DROP TRIGGER IF EXISTS zz_gc2_close_on_creditor_je ON gl_journal_entries');
      await a.pool.query('DROP FUNCTION IF EXISTS public.zz_gc2_close_on_creditor_je()');
    }
    expect(await creditorJournals()).toEqual(before); // the 4xx committed, the draft did not survive it
    expect((await a.pool.query('SELECT status, creditor_journal_id FROM payroll_bank_files WHERE id = $1', [String(g.body.data!.id)])).rows[0])
      .toEqual({ status: 'generated', creditor_journal_id: null });
    } finally { a = home; }
  }, 300_000);
});
