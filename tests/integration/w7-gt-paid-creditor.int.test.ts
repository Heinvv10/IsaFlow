/**
 * Wave 7 GT, ledger breaker #1939 D3 (ported): a termination run's instalment that a CONFIRMED salary bank file paid to
 * the creditor (GC2) stays the month's instalment through a reopen of both runs. The regular run recalculated while
 * the termination run is reopened skips the order (another run of the month holds a confirmed creditor payment for it),
 * the termination run re-deducts exactly what its file paid, and the month deducts the order ONCE: before the fix the
 * employee was garnished R2 000 for a R1 000 instalment and the regular run's R1 000 was never paid to the creditor.
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import orderRoute from '../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';
import orders from '../../pages/api/payroll/employees/[id]/garnishee-orders/index';
import { todayInSast } from '@/lib/saDateParser';
import { rig, type Res, type Route } from './brkr.helpers';
import { act, bank, cleanup, enable, generate, payingAccount, type R } from './payroll-bank-file.helpers';

let a: R;
const BANK = { bankName: 'First National Bank', branchCode: '250655', accountNumber: '62001234567', accountType: 'cheque', accountHolder: 'Beta Credit Ltd' };
const ok = (x: Res, code = 200) => expect(x.statusCode, JSON.stringify(x.body)).toBe(code);
const ded = async (run: string, o: string) => (await a.pool.query(
  'SELECT amount::float8 AS amount, balance_applied FROM payroll_garnishee_deductions WHERE run_id = $1 AND order_id = $2', [run, o])).rows[0] ?? null;
const monthApplied = async (o: string) => Number((await a.pool.query(`SELECT COALESCE(sum(d.amount), 0)::float8 AS n
    FROM payroll_garnishee_deductions d JOIN payroll_run_headers h ON h.id = d.run_id
   WHERE d.order_id = $1 AND h.period_year = 2026 AND h.period_month = 12 AND d.balance_applied`, [o])).rows[0]!.n);
const order = async (o: string) => (await a.pool.query(
  'SELECT balance::float8 AS balance, public.payroll_garnishee_order_counted(id)::float8 AS counted FROM payroll_garnishee_orders WHERE id = $1', [o])).rows[0];
const journal = async (run: string) => (await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0].journal_entry_id as string | null;
/** Re-approve a recalculated run: its old journal reversed first (the recalc gate), then the R-035 authorisation. */
async function approveAgain(run: string, oldJournal: string | null): Promise<void> {
  if (oldJournal) ok(await a.api.reverse(oldJournal));
  await a.authorise(run);
  ok(await a.api.approve(run));
}

let emp = '';
let o = '';
let regular = '';
let term = '';

beforeAll(async () => {
  a = await rig('w7-gt-paid');
  await a.setup();
  await enable(a);
  await payingAccount(a);
  emp = (await a.employee(15_000)).employee;
  await bank(a, emp, '4071234568');
  regular = await a.calculatedRun(12);
  ok(await a.api.approve(regular));
  // The order is captured after the regular run: only the termination run takes it.
  const m = await a.call(orders as Route, 'POST', `/api/payroll/employees/${emp}/garnishee-orders`, emp, { body: {
    kind: 'emolument_attachment', reference: 'GTB 3', creditorName: 'Beta', priority: 10, endDate: null, instalment: 1000, totalDebt: 5000, startDate: '2026-01-01',
  } });
  ok(m, 201);
  o = String(m.body.data!.id);
  const put = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId: o };
    return (orderRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  ok(await a.call(put, 'PUT', `/api/payroll/employees/${emp}/garnishee-orders/${o}`, emp, { body: BANK }));
  await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-12-24', termination_reason = 'resignation', termination_notice_period_days = 10,
    termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [emp]);
}, 180_000);

afterAll(async () => {
  await a.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [a.company]);
  await a.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM payroll_bank_file_items WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await cleanup(a);
}, 180_000);

describe('a confirmed creditor payment holds the month\'s instalment through a reopen (breaker #1939 D3)', () => {
  it('the termination run deducts, is approved and its bank file confirmed: the creditor is paid R1 000', async () => {
    const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined,
      { body: { month: 12, year: 2026, reason: 'termination', runDate: '2026-12-27', employees: [{ employeeId: emp }] } });
    ok(made, 201);
    term = String(made.body.data!.id);
    ok(await a.api.calculate(term));
    await a.authorise(term);
    ok(await a.api.approve(term));
    const g = await generate(a, term, { actionDate: todayInSast() });
    ok(g);
    ok(await act(a, term, String(g.body.data!.id), 'confirm', { body: {} }));
    expect(await ded(term, o)).toEqual({ amount: 1000, balance_applied: true });
    expect(await order(o)).toEqual({ balance: 4000, counted: 1000 });
  });

  it('both reopened, the regular run recalculated skips the order the termination run\'s file paid', async () => {
    const regularJournal = await journal(regular);
    ok(await a.api.reopen(term));
    ok(await a.api.reopen(regular));
    expect(await order(o)).toEqual({ balance: 4000, counted: 1000 }); // the paid instalment stays counted through the reopen
    ok(await a.api.calculate(regular));
    expect(await ded(regular, o)).toBeNull();
    await approveAgain(regular, regularJournal);
  });

  it('the termination run re-deducts exactly what its file paid; the month deducts the order once', async () => {
    const termJournal = await journal(term);
    ok(await a.api.calculate(term));
    expect(await ded(term, o)).toEqual({ amount: 1000, balance_applied: false });
    await approveAgain(term, termJournal);
    expect(await monthApplied(o)).toBe(1000);
    expect(await order(o)).toEqual({ balance: 4000, counted: 1000 });
  });
});
