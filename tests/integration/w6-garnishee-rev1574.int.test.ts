/**
 * The payroll/ledger breaker's repros for PR #1574 (garnishee orders), kept as regression tests, plus the stale-order
 * refusal in both directions (security review M2 = breaker M):
 *  - B1 / B1b (H1/H2): an end date is the order's last day: a future end date keeps deducting, and reopening the
 *    order's last month keeps its instalment;
 *  - B2: an order entered after the run was calculated refuses approval (recalculate), and a recalculation clears it;
 *  - B3: an order ended after calculation, with an end date before the run's period, refuses approval the same way.
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import orders from '../../pages/api/payroll/employees/[id]/garnishee-orders/index';
import endOrder from '../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';
import { rig, type Res, type Route } from './brkr.helpers';

type R = Awaited<ReturnType<typeof rig>>;
let a: R;
let emp = '';

const post = (employee: string, body: unknown) =>
  a.call(orders as Route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders`, employee, { body });
const end = (employee: string, orderId: string, body: unknown): Promise<Res> => {
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId };
    return (endOrder as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  return a.call(route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders/${orderId}`, employee, { body });
};
const deductions = async (runId: string) => (await a.pool.query(
  'SELECT d.amount::float8 AS amount FROM payroll_garnishee_deductions d WHERE d.run_id = $1', [runId])).rows;

beforeAll(async () => {
  a = await rig('rev1574-brk');
  await a.setup();
  emp = (await a.employee(20000)).employee;
}, 120_000);
afterAll(async () => {
  if (!a) return;
  await a.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [a.company]);
  await a.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [a.company]);
  await a.teardown();
});

describe('rev-1574 breaker', () => {
  it('B1: ending an order with a FUTURE end date stops deductions in periods on or before that date', async () => {
    const made = await post(emp, {
      kind: 'maintenance', reference: 'MC 9/2026', creditorName: 'Child maintenance', instalment: 1000, totalDebt: null,
      startDate: '2026-01-01', endDate: null, priority: 10,
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const run3 = await a.calculatedRun(3);
    expect(await deductions(run3)).toEqual([{ amount: 1000 }]); // sanity: the order deducts
    // The court's order runs to the end of the year; the payroll user records that end date now.
    const ended = await end(emp, String(made.body.data!.id), { endDate: '2026-12-31', reason: 'Order runs to 31 Dec 2026 per court' });
    expect(ended.statusCode, JSON.stringify(ended.body)).toBe(200);
    // April is before 31 Dec, so the route's own contract ("runs whose period starts after endDate no longer deduct")
    // says April still deducts R1 000.
    const run4 = await a.calculatedRun(4);
    expect(await deductions(run4)).toEqual([{ amount: 1000 }]);
  });

  it('B1b: an order ended at 31 May (past, correct) loses May\'s deduction when the May run is reopened and recalculated', async () => {
    const emp2 = (await a.employee(20000)).employee;
    const made = await post(emp2, {
      kind: 'maintenance', reference: 'MC 10/2026', creditorName: 'Child maintenance', instalment: 700, totalDebt: null,
      startDate: '2026-01-01', endDate: null, priority: 10,
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const run5 = await a.calculatedRun(5);
    const mine = async () => (await a.pool.query(
      'SELECT amount::float8 AS amount FROM payroll_garnishee_deductions WHERE run_id = $1 AND employee_id = $2', [run5, emp2])).rows;
    expect(await mine()).toEqual([{ amount: 700 }]);
    const ap = await a.api.approve(run5);
    expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
    // The order ends with May, the last month it is owed.
    expect((await end(emp2, String(made.body.data!.id), { endDate: '2026-05-31', reason: 'Child turned 18 in May' })).statusCode).toBe(200);
    // May is reopened for an unrelated correction and recalculated: May is on or before the end date, so it still owes R700.
    expect((await a.api.reopen(run5)).statusCode).toBe(200);
    expect((await a.api.calculate(run5)).statusCode).toBe(200);
    expect(await mine()).toEqual([{ amount: 700 }]);
  });

  it('B2: an order entered after the run was calculated is approved past, with no refusal and no deduction', async () => {
    const emp3 = (await a.employee(20000)).employee;
    const run6 = await a.calculatedRun(6);
    const made = await post(emp3, {
      kind: 'emolument_attachment', reference: 'EAO 11/2026', creditorName: 'Acme Credit', instalment: 1500, totalDebt: 9000,
      startDate: '2026-06-01', endDate: null, priority: 10,
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    // An assignment change after calculation refuses approval (components_changed_after_calculation); an order does not.
    const before = await a.header(run6);
    const ap = await a.api.approve(run6);
    expect(ap.statusCode, 'approval should refuse: an order for June was entered after June was costed').toBe(400);
    expect(a.msg(ap)).toMatch(/order to Acme Credit \(R\s?1[\s,]?500\.00 a month\) was entered after this run was calculated/);
    expect(a.msg(ap)).not.toContain('EAO 11/2026');
    expect(await a.header(run6)).toEqual(before); // refused before any write
    expect((await a.api.calculate(run6)).statusCode).toBe(200);
    await a.authorise(run6);
    const again = await a.api.approve(run6);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(await deductions(run6)).toContainEqual({ amount: 1500 });
  });

  it('B3: an order ended after calculation, ending before the run\'s period, refuses approval until recalculated', async () => {
    const emp4 = (await a.employee(20000)).employee;
    const made = await post(emp4, {
      kind: 'maintenance', reference: 'MC 12/2026', creditorName: 'Maintenance creditor', instalment: 500, totalDebt: null,
      startDate: '2026-01-01', endDate: null, priority: 10,
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const run7 = await a.calculatedRun(7);
    const mine = async () => (await a.pool.query(
      'SELECT amount::float8 AS amount FROM payroll_garnishee_deductions WHERE run_id = $1 AND employee_id = $2', [run7, emp4])).rows;
    expect(await mine()).toEqual([{ amount: 500 }]);
    expect((await end(emp4, String(made.body.data!.id), { endDate: '2026-06-30', reason: 'Order discharged in June' })).statusCode).toBe(200);
    const before = await a.header(run7);
    const ap = await a.api.approve(run7);
    expect(ap.statusCode, JSON.stringify(ap.body)).toBe(400);
    expect(a.msg(ap)).toMatch(/order to Maintenance creditor \(R\s?500\.00 a month\) was ended after this run was calculated/);
    expect(await a.header(run7)).toEqual(before);
    expect((await a.api.calculate(run7)).statusCode).toBe(200);
    await a.authorise(run7);
    const again = await a.api.approve(run7);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(await mine()).toEqual([]);
  });
});
