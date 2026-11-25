/**
 * Wave 7 GC2, breaker HIGH on #1929 (repro by the GC2 breaker, G1/G2/G3 ported): a run whose salary bank file was
 * CONFIRMED with garnishee creditor lines has paid those creditors, so re-approving it with another deduction for one of
 * those orders is refused 409 before any write (payrollBankFileReapproval, from the approval's garnishee judge), naming
 * the order, the confirmed amount and the new one. Over the months the creditor is never paid past the order's debt.
 * Real routes, withAuth, app_user, RLS; disposable fixture (rig -> assertDisposable); a second tenant sees nothing.
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
const ORDER = { kind: 'emolument_attachment', reference: 'EAO 9/2026', creditorName: 'Acme Credit', priority: 10, endDate: null };

const putBank = (r: R, employee: string, id: string, body: unknown) => {
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId: id };
    return (orderRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  return r.call(route, 'PUT', `/api/payroll/employees/${employee}/garnishee-orders/${id}`, employee, { body });
};
async function newOrder(r: R, employee: string, body: Record<string, unknown>): Promise<string> {
  const m = await r.call(orders as Route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders`, employee, { body: { ...ORDER, ...body } });
  if (m.statusCode !== 201) throw new Error(JSON.stringify(m.body));
  const id = String(m.body.data!.id);
  expect((await putBank(r, employee, id, BANK)).statusCode).toBe(200);
  return id;
}
const order = async (r: R, id: string) => (await r.pool.query(
  'SELECT status, balance::float8 AS balance, total_debt::float8 AS total_debt FROM payroll_garnishee_orders WHERE id = $1', [id])).rows[0]!;
const deductions = async (r: R, run: string) => (await r.pool.query(
  'SELECT order_id, amount::float8 AS amount, balance_applied FROM payroll_garnishee_deductions WHERE run_id = $1 ORDER BY order_id', [run])).rows;
const paidToCreditor = async (r: R, id: string) => Number((await r.pool.query(
  `SELECT COALESCE(sum(i.amount_cents), 0)::float8 / 100 AS n FROM payroll_bank_file_items i JOIN payroll_bank_files f ON f.id = i.file_id
    WHERE i.garnishee_order_id = $1 AND f.status = 'confirmed'`, [id])).rows[0]!.n);
const payableGl = async (r: R) => Number((await r.pool.query(
  `SELECT COALESCE(sum(l.debit - l.credit), 0)::float8 AS n FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     JOIN gl_accounts g ON g.id = l.gl_account_id WHERE e.company_id = $1 AND e.status = 'posted' AND g.account_name = 'Garnishee Orders Payable'`,
  [r.company])).rows[0]!.n);
const head = async (r: R, run: string) => (await r.pool.query(
  'SELECT status, approved_at, journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0]!;

/** Approve, generate (action date today) and confirm; returns the run. */
async function paidRun(r: R, month: number, year: number): Promise<string> {
  const run = await r.calculatedRun(month, year);
  const ap = await r.api.approve(run);
  expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
  const g = await generate(r, run, { actionDate: TODAY });
  expect(g.statusCode, JSON.stringify(g.body)).toBe(200);
  const c = await act(r, run, String(g.body.data!.id), 'confirm', { body: {} });
  expect(c.statusCode, JSON.stringify(c.body)).toBe(200);
  return run;
}

beforeAll(async () => {
  a = await rig('w7-gc2-reapprove-a');
  b = await rig('w7-gc2-reapprove-b');
  for (const r of [a, b]) { await r.setup(); await enable(r); await payingAccount(r); }
}, 120_000);
afterAll(async () => {
  for (const r of [a, b].filter(Boolean)) {
    await r.pool.query('DELETE FROM payroll_bank_file_items WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_bank_files WHERE company_id = $1', [r.company]);
    await r.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [r.company]);
    await r.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [r.company]);
    await cleanup(r);
  }
}, 120_000);

describe('re-approving a run whose confirmed bank file paid garnishee creditors', () => {
  it('G1+G3: a re-approval that would deduct a paid order differently is refused 409, writing nothing; over the months the creditor is paid exactly the debt', async () => {
    const emp = (await a.employee(200000)).employee;
    await bank(a, emp, '4071234567');
    const o = await newOrder(a, emp, { instalment: 10000, totalDebt: 30000, startDate: '2026-01-01' });
    const oct = await paidRun(a, 10, 2026);
    expect(await paidToCreditor(a, o)).toBe(10000);
    expect(await order(a, o)).toMatchObject({ balance: 20000, status: 'active' });

    // Reopen; a priority order takes the whole cap; the run's journal reversed; recalculated: the paid order now takes nil.
    expect((await a.api.reopen(oct)).statusCode).toBe(200);
    const big = await newOrder(a, emp, { reference: 'BIG', instalment: 900000, totalDebt: null, priority: 1, startDate: '2026-10-01', endDate: '2026-10-31' });
    const je = String((await head(a, oct)).journal_entry_id);
    expect((await a.api.reverse(je)).statusCode).toBe(200);
    expect((await a.api.calculate(oct)).statusCode).toBe(200);
    expect((await deductions(a, oct)).find((d) => d.order_id === o)).toBeUndefined();
    await a.authorise(oct);
    const before = { head: await head(a, oct), order: await order(a, o), deductions: await deductions(a, oct), gl: await payableGl(a) };
    const refused = await a.api.approve(oct);
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(409);
    expect(String(refused.body.error?.message ?? refused.body.message)).toMatch(
      /Acme Credit \(employee BRK-1\) was paid R.?10.000\.00 by this run's confirmed salary bank file, but the run would now deduct R.?0\.00/);
    expect({ head: await head(a, oct), order: await order(a, o), deductions: await deductions(a, oct), gl: await payableGl(a) }).toEqual(before);

    // The remedy: the order that took the cap goes (it was entered in error), the run deducts what the bank paid again.
    await a.pool.query('DELETE FROM payroll_garnishee_deductions WHERE order_id = $1 AND NOT balance_applied', [big]);
    await a.pool.query('DELETE FROM payroll_garnishee_orders WHERE id = $1', [big]);
    expect((await a.api.calculate(oct)).statusCode).toBe(200);
    await a.authorise(oct);
    expect((await a.api.approve(oct)).statusCode).toBe(200);
    expect(await order(a, o)).toMatchObject({ balance: 20000 });

    // G3: later months garnish the rest and stop at the debt.
    for (const [m, y] of [[11, 2026], [12, 2026]] as const) await paidRun(a, m, y);
    const jan = await a.calculatedRun(1, 2027);
    expect((await a.api.approve(jan)).statusCode).toBe(200);
    expect(await deductions(a, jan)).toEqual([]);
    expect(await paidToCreditor(a, o)).toBe(30000);
    expect(await paidToCreditor(a, o)).toBeLessThanOrEqual((await order(a, o)).total_debt);
    expect(await order(a, o)).toMatchObject({ balance: 0, status: 'satisfied' });
    expect(await payableGl(a)).toBe(0);
    // Tenant B saw nothing of it.
    expect((await b.pool.query('SELECT count(*)::int AS n FROM payroll_bank_files WHERE company_id = $1', [b.company])).rows[0]!.n).toBe(0);
  }, 240_000);

  it('G2 (both orderings): a stale file is not confirmed while the run applies another deduction, reopened or re-approved; it is once they match (B, 10x)', async () => {
    const e = await b.employee(2000000);
    await bank(b, e.employee, '4071234568');
    const o = await newOrder(b, e.employee, { reference: 'G2', instalment: 100000, totalDebt: 300000, startDate: '2026-01-01' });
    const run = await b.calculatedRun(9, 2026);
    expect((await b.api.approve(run)).statusCode).toBe(200);
    const g = await generate(b, run, { actionDate: TODAY });
    expect(g.statusCode, JSON.stringify(g.body)).toBe(200);
    const file = String(g.body.data!.id);
    expect((await b.api.reopen(run)).statusCode).toBe(200);
    const fileState = async () => (await b.pool.query('SELECT status, creditor_journal_id FROM payroll_bank_files WHERE id = $1', [file])).rows[0];

    // Reopened: no deduction applied, so the stale file cannot record a creditor payment (even attested).
    const whileOpen = await act(b, run, file, 'confirm', { body: { paidAsGenerated: true } });
    expect([whileOpen.statusCode, reason(whileOpen)], JSON.stringify(whileOpen.body)).toEqual([409, 'CREDITOR_AMOUNT_DIFFERS']);
    expect(await fileState()).toEqual({ status: 'generated', creditor_journal_id: null });

    // The other ordering: re-approved with a smaller deduction (no confirmed file yet, so approval allows it), THEN confirm.
    expect((await b.api.reverse(String((await head(b, run)).journal_entry_id))).statusCode).toBe(200);
    await b.setSalary(e.salaryRow, 200000);
    expect((await b.api.calculate(run)).statusCode).toBe(200);
    await b.authorise(run);
    expect((await b.api.approve(run)).statusCode).toBe(200);
    const smaller = (await deductions(b, run)).find((d) => d.order_id === o)!.amount;
    expect(smaller).toBeLessThan(100000);
    const before = { order: await order(b, o), gl: await payableGl(b) };
    const after = await act(b, run, file, 'confirm', { body: {} });
    expect([after.statusCode, reason(after)]).toEqual([409, 'CREDITOR_AMOUNT_DIFFERS']);
    expect(after.body.error.details.problems[0]).toMatch(/the file paid R.?100.000\.00, the run now applies R/);
    expect({ order: await order(b, o), gl: await payableGl(b), file: await fileState() })
      .toEqual({ ...before, file: { status: 'generated', creditor_journal_id: null } });

    // Remedy: approved again with the deduction the file paid; the confirm then records it, and the balance counts it.
    expect((await b.api.reopen(run)).statusCode).toBe(200);
    expect((await b.api.reverse(String((await head(b, run)).journal_entry_id))).statusCode).toBe(200);
    await b.setSalary(e.salaryRow, 2000000);
    expect((await b.api.calculate(run)).statusCode).toBe(200);
    await b.authorise(run);
    expect((await b.api.approve(run)).statusCode).toBe(200);
    const ok = await act(b, run, file, 'confirm', { body: {} });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(await paidToCreditor(b, o)).toBe(100000);
    expect(await order(b, o)).toMatchObject({ balance: 200000 });
  }, 240_000);

  it('race: a confirm waits for the run header an approval / reopen holds, then judges what it committed (two sessions)', async () => {
    const e = await b.employee(2000000);
    await bank(b, e.employee, '4071234569');
    const o = await newOrder(b, e.employee, { reference: 'RACE', instalment: 100000, totalDebt: 300000, startDate: '2026-01-01' });
    const run = await b.calculatedRun(10, 2026);
    expect((await b.api.approve(run)).statusCode).toBe(200);
    const g = await generate(b, run, { actionDate: TODAY });
    expect(g.statusCode).toBe(200);
    const c = await b.pool.connect();
    try {
      // Session 1 holds the header as a reopen does and takes the run's deduction back out (what a reopen commits).
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM payroll_run_headers WHERE id = $1 FOR UPDATE', [run]);
      const pending = act(b, run, String(g.body.data!.id), 'confirm', { body: {} });
      for (let i = 0; ; i += 1) {
        const waiting = await b.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%' AND pid <> $1",
          [(await c.query('SELECT pg_backend_pid() AS p')).rows[0]!.p]);
        if (waiting.rows[0]!.n > 0) break;
        if (i > 300) throw new Error('the confirm never waited on the header');
        await new Promise((r) => setTimeout(r, 100));
      }
      await c.query("UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL, approval_grandfathered_at = NULL WHERE id = $1", [run]);
      await c.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE run_id = $1', [run]);
      await c.query("UPDATE payroll_garnishee_orders SET balance = total_debt, status = 'active' WHERE id = $1", [o]);
      await c.query('COMMIT');
      const res = await pending;
      expect([res.statusCode, reason(res)], JSON.stringify(res.body)).toEqual([409, 'CREDITOR_AMOUNT_DIFFERS']);
    } finally { c.release(); }
    expect(await paidToCreditor(b, o)).toBe(0);
  }, 240_000);
});
