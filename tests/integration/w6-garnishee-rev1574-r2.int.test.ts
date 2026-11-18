/**
 * The payroll/ledger breaker's round-2 probes for PR #1574 (garnishee orders), kept as regression tests:
 *  - (a) an order ended mid-period takes March's full instalment and the line warns GARNISHEE_PART_MONTH (named
 *    limit); April takes nothing;
 *  - (b1) an order ended back past an approved run refuses re-approval without a recalculation; recalculated, the run
 *    takes nothing and the order's balance is whole;
 *  - (b2) a new order entered while a run is reopened refuses re-approval without a recalculation;
 *  - (c) the race: an order written (by any writer, here raw SQL) while a calculation runs. The 999z trigger takes the
 *    company's payroll approval lock, which calculate holds, so the calculation waits for the uncommitted order and
 *    then takes it: the order is never missed. (The breaker's original (c) had the calculation run past it.)
 *  - (d) ending an order with raw SQL (so only the 999z trigger takes the lock, not the route) waits while a
 *    calculation holds the company's payroll approval lock.
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import orders from '../../pages/api/payroll/employees/[id]/garnishee-orders/index';
import endOrder from '../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';
import { payrollApprovalLockScope } from '../../src/modules/accounting/services/payroll/payrollRunLock';
import { rig, type Res, type Route } from './brkr.helpers';

type R = Awaited<ReturnType<typeof rig>>;
let a: R;
const post = (employee: string, body: unknown) =>
  a.call(orders as Route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders`, employee, { body });
const end = (employee: string, orderId: string, body: unknown): Promise<Res> => {
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId };
    return (endOrder as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  return a.call(route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders/${orderId}`, employee, { body });
};
const mine = async (run: string, emp: string) => (await a.pool.query(
  'SELECT amount::float8 AS amount FROM payroll_garnishee_deductions WHERE run_id = $1 AND employee_id = $2', [run, emp])).rows;
const codes = async (run: string, emp: string) => ((await a.pool.query(
  'SELECT validation_results FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, emp])).rows[0]!.validation_results as Array<{ code: string }>)
  .map((v) => v.code).filter((c) => c.startsWith('GARNISHEE'));
const order = async (id: string) => (await a.pool.query(
  'SELECT balance::float8 AS balance, status FROM payroll_garnishee_orders WHERE id = $1', [id])).rows[0];
const body = (o: Record<string, unknown>) => ({ kind: 'maintenance', reference: 'X', creditorName: 'Cred', instalment: 900, totalDebt: null,
  startDate: '2026-01-01', endDate: null, priority: 10, ...o });

/** Wait (at most 10s) until some backend is blocked on an advisory lock: the write under test has reached the lock. */
const advisoryWaiter = async (): Promise<boolean> => {
  for (let i = 0; i < 100; i += 1) {
    const n = (await a.pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'")).rows[0]!.n;
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

beforeAll(async () => { a = await rig('rev1574-r2'); await a.setup(); }, 120_000);
afterAll(async () => {
  if (!a) return;
  await a.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [a.company]);
  await a.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [a.company]);
  await a.teardown();
});

describe('rev-1574 round 2', () => {
  it('(a) an order ended mid-period (15 Mar): March takes the full instalment and warns GARNISHEE_PART_MONTH; April nothing', async () => {
    const emp = (await a.employee(20000)).employee;
    const made = await post(emp, body({ reference: 'MID' }));
    expect(made.statusCode).toBe(201);
    expect((await end(emp, String(made.body.data!.id), { endDate: '2026-03-15', reason: 'Order ends mid March' })).statusCode).toBe(200);
    const run3 = await a.calculatedRun(3);
    expect(await mine(run3, emp)).toEqual([{ amount: 900 }]);
    expect(await codes(run3, emp)).toContain('GARNISHEE_PART_MONTH');
    const ap3 = await a.api.approve(run3);
    expect(ap3.statusCode, a.msg(ap3)).toBe(200);
    const run4 = await a.calculatedRun(4);
    expect(await mine(run4, emp)).toEqual([]);
    const ap4 = await a.api.approve(run4);
    expect(ap4.statusCode, a.msg(ap4)).toBe(200);
  });

  it('(b1) reopen after the order is ended back past the run, re-approve WITHOUT recalculating', async () => {
    const emp = (await a.employee(20000)).employee;
    const made = await post(emp, body({ kind: 'emolument_attachment', reference: 'EAO-B', instalment: 1500, totalDebt: 9000 }));
    const id = String(made.body.data!.id);
    const run5 = await a.calculatedRun(5);
    const ap5 = await a.api.approve(run5);
    expect(ap5.statusCode, a.msg(ap5)).toBe(200);
    expect(await order(id)).toEqual({ balance: 7500, status: 'active' });
    expect((await end(emp, id, { endDate: '2026-04-30', reason: 'Court set aside from May' })).statusCode).toBe(200);
    expect((await a.api.reopen(run5)).statusCode).toBe(200);
    expect(await order(id)).toEqual({ balance: 9000, status: 'ended' });
    await a.authorise(run5);
    const re = await a.api.approve(run5);
    expect(re.statusCode, a.msg(re)).toBe(400);
    expect(a.msg(re)).toMatch(/was ended after this run was calculated/);
    expect((await a.api.calculate(run5)).statusCode).toBe(200);
    await a.authorise(run5);
    const hd = (await a.pool.query('SELECT calculated_at, status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [run5])).rows[0];
    const rv = await a.api.reverse(String(hd.journal_entry_id));
    expect(rv.statusCode, JSON.stringify(rv.body)).toBe(200);
    const fin = await a.api.approve(run5);
    expect(fin.statusCode, `${a.msg(fin)} ${JSON.stringify(hd)}`).toBe(200);
    expect(await mine(run5, emp)).toEqual([]);
    expect(await order(id)).toEqual({ balance: 9000, status: 'ended' });
    const led = (await a.pool.query(`SELECT sum(l.credit - l.debit)::float8 AS cr FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      JOIN gl_accounts g ON g.id = l.gl_account_id WHERE e.company_id = $1 AND e.status = 'posted' AND g.account_name = 'Garnishee Orders Payable'
      AND e.entry_date BETWEEN '2026-05-01' AND '2026-05-31'`, [a.company])).rows[0];
    expect(led.cr ?? 0).toBeCloseTo(0, 2); // May's postings net to nil on the payable (approved, reversed, re-approved with none)
  });

  it('(b2) reopen, a NEW order entered, re-approve without recalculating', async () => {
    const emp = (await a.employee(20000)).employee;
    const run6 = await a.calculatedRun(6);
    expect((await a.api.approve(run6)).statusCode).toBe(200);
    expect((await a.api.reopen(run6)).statusCode).toBe(200);
    expect((await post(emp, body({ reference: 'NEW-B2', startDate: '2026-06-01' }))).statusCode).toBe(201);
    await a.authorise(run6);
    const re = await a.api.approve(run6);
    expect(re.statusCode, a.msg(re)).toBe(400);
    expect(a.msg(re)).toMatch(/was entered after this run was calculated/);
  });

  it('(c) RACE: an order written while the run is calculated is waited for and taken, never missed', async () => {
    const emp = (await a.employee(20000)).employee;
    // A first order so the payable exists; it ends before July.
    const first = await post(emp, body({ reference: 'SEED', endDate: '2026-01-31' }));
    expect(first.statusCode).toBe(201);
    const payable = (await a.pool.query('SELECT payable_account_id FROM payroll_garnishee_orders WHERE id = $1', [first.body.data!.id])).rows[0]!.payable_account_id;
    const run7made = await a.api.createRun(7);
    const run7 = String(run7made.body.data!.id);
    const c = await a.pool.connect();
    let calcSettled = false;
    let calc: Promise<Res> | null = null;
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated' })]);
      // The order row is written but not yet committed (raw SQL: the trigger, not the service, takes the lock here).
      await c.query(`INSERT INTO payroll_garnishee_orders (company_id, employee_id, kind, reference, creditor_name, instalment, total_debt, balance,
        start_date, priority, payable_account_id, created_by) VALUES ($1, $2, 'maintenance', 'RACE', 'Race creditor', 800, NULL, NULL, '2026-07-01', 10, $3, 'x')`,
        [a.company, emp, payable]);
      calc = a.api.calculate(run7).finally(() => { calcSettled = true; });
      expect(await advisoryWaiter(), 'the calculation never waited on the order\'s lock').toBe(true);
      expect(calcSettled, 'the calculation ran past an uncommitted order').toBe(false);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    const done = await calc!;
    expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
    expect(await mine(run7, emp)).toEqual([{ amount: 800 }]);
    await a.authorise(run7);
    const ap = await a.api.approve(run7);
    expect(ap.statusCode, a.msg(ap)).toBe(200);
  });

  it('(d) ending an order with raw SQL waits while another transaction holds the company\'s payroll approval lock (the trigger\'s lock)', async () => {
    const emp = (await a.employee(20000)).employee;
    const made = await post(emp, body({ reference: 'END-LOCK' }));
    expect(made.statusCode).toBe(201);
    const id = String(made.body.data!.id);
    const holder = await a.pool.connect();
    const writer = await a.pool.connect();
    let settled = false;
    let ended: Promise<unknown> | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [payrollApprovalLockScope(a.company)]);
      await writer.query('BEGIN');
      await writer.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated' })]);
      // Raw SQL, not the route: nothing but the 999z trigger takes the approval lock for this end.
      ended = writer.query(
        "UPDATE payroll_garnishee_orders SET status = 'ended', end_date = '2026-09-30', end_reason = 'Order discharged in September' WHERE id = $1",
        [id]).finally(() => { settled = true; });
      expect(await advisoryWaiter(), 'the end never waited on the approval lock').toBe(true);
      expect(settled, 'the order was ended while a calculation held the lock').toBe(false);
    } finally {
      await holder.query('COMMIT').catch(() => undefined);
      holder.release();
    }
    try {
      await ended!;
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    expect((await order(id)).status).toBe('ended');
  });
});
