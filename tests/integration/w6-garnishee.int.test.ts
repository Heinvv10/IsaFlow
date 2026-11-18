/**
 * Garnishee orders (wave 6 GA) through the real routes, withAuth, app_user and RLS, on two tenants.
 * Claims:
 *  - F13: a company without orders gets no new account; the first order creates the garnishee payable once, and a later
 *    order reuses it;
 *  - refusals (bad body, another tenant's employee, a viewer) change no row;
 *  - the run deducts the attachment at the s65J(1A)(a) 25% limit and maintenance outside it, after tax;
 *  - the balance moves at approval only (never at calculate), is restored at reopen, and an order paid off is satisfied;
 *  - the journal balances, with the garnishee deductions on their own payable line and none on 2175;
 *  - the tables refuse a balance the deductions do not explain and a deduction written for another tenant.
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import orders from '../../pages/api/payroll/employees/[id]/garnishee-orders/index';
import endOrder from '../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';
import { rig, type Res, type Route } from './brkr.helpers';

type R = Awaited<ReturnType<typeof rig>>;
let a: R;
let b: R;
let emp = '';
let empB = '';

const order = (body: Record<string, unknown>) => ({
  kind: 'emolument_attachment', reference: 'EAO 12/2026', creditorName: 'Acme Credit', instalment: 6000, totalDebt: 10000,
  startDate: '2026-01-01', endDate: null, priority: 10, ...body,
});
const post = (r: R, employee: string, body: unknown, o: { company?: string; user?: string } = {}) =>
  r.call(orders as Route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders`, employee, { ...o, body });
const list = (r: R, employee: string, o: { company?: string; user?: string } = {}) =>
  r.call(orders as Route, 'GET', `/api/payroll/employees/${employee}/garnishee-orders`, employee, o);
const end = (r: R, employee: string, orderId: string, body: unknown): Promise<Res> => {
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId };
    return (endOrder as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  return r.call(route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders/${orderId}`, employee, { body });
};
const reason = (x: Res) => x.body.error?.details?.reason as string | undefined;
const payables = async (r: R) => (await r.pool.query(
  "SELECT id, account_code, account_subtype, is_system_account FROM gl_accounts WHERE company_id = $1 AND account_name = 'Garnishee Orders Payable'",
  [r.company])).rows;
const orderRows = async (r: R) => (await r.pool.query(
  'SELECT id, kind, balance::float8 AS balance, status, created_by FROM payroll_garnishee_orders WHERE company_id = $1 ORDER BY created_at, id',
  [r.company])).rows;
const deductions = async (r: R, runId: string) => (await r.pool.query(
  `SELECT o.kind, d.requested::float8 AS requested, d.amount::float8 AS amount, d.balance_applied
     FROM payroll_garnishee_deductions d JOIN payroll_garnishee_orders o ON o.id = d.order_id
    WHERE d.run_id = $1 ORDER BY o.kind`, [runId])).rows;
const line = async (r: R, runId: string) => (await r.pool.query(
  'SELECT gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif, net_pay::float8 AS net, validation_results FROM payroll_run_lines WHERE run_id = $1',
  [runId])).rows[0]!;
const approve = async (r: R, runId: string) => {
  const ap = await r.api.approve(runId);
  expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
};

beforeAll(async () => {
  a = await rig('garnishee-a');
  b = await rig('garnishee-b');
  await a.setup();
  await b.setup();
  emp = (await a.employee(20000)).employee;
  empB = (await b.employee(30000)).employee;
}, 120_000);
afterAll(async () => {
  for (const r of [a, b].filter(Boolean)) {
    // The deductions' guard keeps an approved run's rows: unapprove, unapply, then delete (as a reopen would).
    await r.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [r.company]);
    await r.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [r.company]);
    await r.teardown();
  }
});

describe('garnishee orders', () => {
  it('F13: a company without orders has no garnishee payable, and its run is costed and journaled as before', async () => {
    const runB = await b.calculatedRun(3);
    await approve(b, runB);
    expect(await payables(b)).toEqual([]);
    const l = await line(b, runB);
    expect(l.net).toBeCloseTo(l.gross - l.paye - l.uif, 2);
    expect(await payables(a)).toEqual([]);
  });

  it('refuses, writing nothing: a bad body, another tenant, a viewer', async () => {
    expect((await post(a, emp, order({ instalment: -1 }))).statusCode).toBe(400);
    expect((await post(a, emp, order({ instalment: 10.005 }))).statusCode).toBe(400);
    expect((await post(a, emp, { ...order({}), extra: 1 })).statusCode).toBe(400);
    expect((await post(a, emp, order({ endDate: '2025-12-31' }))).statusCode).toBe(400);
    expect((await post(a, emp, order({ kind: 'payday_loan' }))).statusCode).toBe(400);
    const cross = await post(b, emp, order({}));
    expect([cross.statusCode, reason(cross)]).toEqual([404, 'EMPLOYEE_NOT_FOUND']);
    expect((await list(b, emp)).statusCode).toBe(404);
    const viewer = await a.addUser('viewer');
    expect((await post(a, emp, order({}), { user: viewer })).statusCode).toBe(403);
    expect(await orderRows(a)).toEqual([]);
    expect(await payables(a)).toEqual([]);
  });

  it('the first order creates the payable once; the second reuses it; B sees none of it', async () => {
    const first = await post(a, emp, order({}));
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const second = await post(a, emp, order({ kind: 'maintenance', reference: 'MC 3/2026', creditorName: 'Child maintenance', instalment: 4000, totalDebt: null }));
    expect(second.statusCode).toBe(201);
    const accounts = await payables(a);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ account_code: '2180', account_subtype: 'payroll_liability', is_system_account: true });
    const rows = await orderRows(a);
    expect(rows.map((o) => [o.kind, o.balance, o.status, o.created_by])).toEqual([
      ['emolument_attachment', 10000, 'active', a.admin], ['maintenance', null, 'active', a.admin],
    ]);
    expect((await list(a, emp)).body.data!.orders).toHaveLength(2);
    expect(await payables(b)).toEqual([]);
  });

  let run3 = '';
  it('calculate deducts after tax, attachment at 25% of basic salary, maintenance outside it; the balance does not move', async () => {
    run3 = await a.calculatedRun(3);
    const l = await line(a, run3);
    expect(l.net).toBeCloseTo(l.gross - l.paye - l.uif - 5000 - 4000, 2);
    expect((l.validation_results as Array<{ code: string }>).map((v) => v.code)).toContain('GARNISHEE_LIMIT_APPLIED');
    expect(await deductions(a, run3)).toEqual([
      { kind: 'emolument_attachment', requested: 6000, amount: 5000, balance_applied: false },
      { kind: 'maintenance', requested: 4000, amount: 4000, balance_applied: false },
    ]);
    expect((await orderRows(a))[0]!.balance).toBe(10000); // never at calculate
  });

  it('approval moves the balance and posts a balanced journal with the payable line; reopen restores it', async () => {
    await approve(a, run3);
    expect((await orderRows(a))[0]!.balance).toBe(5000);
    const ledger = await a.ledger(3);
    expect(Object.values(ledger).reduce((s, v) => s + v, 0)).toBeCloseTo(0, 2);
    expect(ledger['2180']).toBeCloseTo(-9000, 2);
    expect(ledger['2175'] ?? 0).toBeCloseTo(0, 2);
    expect((await a.api.reopen(run3)).statusCode).toBe(200);
    expect((await orderRows(a))[0]).toMatchObject({ balance: 10000, status: 'active' });
    expect((await deductions(a, run3)).every((d) => !d.balance_applied)).toBe(true);
    expect((await a.api.calculate(run3)).statusCode).toBe(200);
    await a.authorise(run3);
    await approve(a, run3);
    expect((await orderRows(a))[0]!.balance).toBe(5000);
  });

  it('the next month pays the order off: satisfied, and the month after deducts only maintenance', async () => {
    const run4 = await a.calculatedRun(4);
    await approve(a, run4);
    expect((await orderRows(a))[0]).toMatchObject({ balance: 0, status: 'satisfied' });
    const run5 = await a.calculatedRun(5);
    expect((await deductions(a, run5)).map((d) => d.kind)).toEqual(['maintenance']);
  });

  it('ending an order: refused for another tenant and twice; the next calculation no longer deducts it', async () => {
    const maintenance = (await orderRows(a))[1]!.id as string;
    expect((await end(a, emp, maintenance, { endDate: '2026-05-31', reason: 'x' })).statusCode).toBe(400);
    expect((await end(a, emp, maintenance, { endDate: '2026-05-31', reason: 'Order rescinded by the court' })).statusCode).toBe(200);
    expect(reason(await end(a, emp, maintenance, { endDate: '2026-05-31', reason: 'Order rescinded by the court' }))).toBe('ORDER_ENDED');
    const run6 = await a.calculatedRun(6);
    expect(await deductions(a, run6)).toEqual([]);
  });

  it('approval refuses, writing nothing, a deduction above what the order now owes; a recalculation fixes it', async () => {
    // Defence in depth: for one employee the year-to-date gates already refuse an approval after another month's (the
    // only way an order's balance moves between this run's calculation and its approval), so the state is forged here:
    // the stored deduction is raised above the balance with the guard trigger off, in one transaction.
    const made = await post(a, emp, order({ reference: 'EAO 7/2026', instalment: 2000, totalDebt: 3000, startDate: '2026-07-01' }));
    expect(made.statusCode).toBe(201);
    const id = String(made.body.data!.id);
    const run7 = await a.calculatedRun(7);
    const c = await a.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE payroll_garnishee_deductions DISABLE TRIGGER payroll_garnishee_deductions_guard');
      await c.query('UPDATE payroll_garnishee_deductions SET requested = 3500, amount = 3500 WHERE run_id = $1 AND order_id = $2', [run7, id]);
      await c.query('ALTER TABLE payroll_garnishee_deductions ENABLE ALWAYS TRIGGER payroll_garnishee_deductions_guard');
      await c.query('COMMIT');
    } finally { c.release(); }
    const refused = await a.api.approve(run7);
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(a.msg(refused)).toMatch(/EAO 7\/2026 now owes R\s?3[\s,]?000\.00 but this run deducts R\s?3[\s,]?500\.00/);
    expect((await a.header(run7)).status).toBe('calculated');
    expect((await orderRows(a)).find((o) => o.id === id)!.balance).toBe(3000);
    expect((await a.api.calculate(run7)).statusCode).toBe(200);
    await a.authorise(run7);
    await approve(a, run7);
    expect((await orderRows(a)).find((o) => o.id === id)).toMatchObject({ balance: 1000, status: 'active' });
  });

  it('the SERVICE never moves a balance at calculate (the deductions guard trigger is off, so only the code decides)', async () => {
    const made = await post(a, emp, order({ reference: 'EAO 8/2026', instalment: 1000, totalDebt: 3000, startDate: '2026-08-01' }));
    expect(made.statusCode).toBe(201);
    const id = String(made.body.data!.id);
    const guard = (on: boolean) => a.pool.query(
      `ALTER TABLE payroll_garnishee_deductions ${on ? 'ENABLE ALWAYS' : 'DISABLE'} TRIGGER payroll_garnishee_deductions_guard`);
    let run8 = '';
    await guard(false);
    try {
      run8 = await a.calculatedRun(8);
    } finally {
      await guard(true);
    }
    const rows = await deductions(a, run8);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((d) => !d.balance_applied)).toBe(true);
    expect((await orderRows(a)).find((o) => o.id === id)!.balance).toBe(3000);
  });

  it('F13 lock: two first orders of a company at once create ONE payable (the role-write lock serialises them)', async () => {
    const made = await Promise.all([
      post(b, empB, order({ reference: 'RACE 1' })), post(b, empB, order({ kind: 'maintenance', reference: 'RACE 2', totalDebt: null })),
    ]);
    expect(made.map((m) => m.statusCode)).toEqual([201, 201]);
    expect(await payables(b)).toHaveLength(1);
    const accounts = new Set((await b.pool.query('SELECT payable_account_id FROM payroll_garnishee_orders WHERE company_id = $1', [b.company])).rows
      .map((r) => r.payable_account_id));
    expect(accounts.size).toBe(1);
  });

  it('the tables refuse a balance the deductions do not explain, and a deduction for another tenant', async () => {
    const attachment = (await orderRows(a))[0]!.id as string;
    await expect(a.pool.query('UPDATE payroll_garnishee_orders SET balance = 7000 WHERE id = $1', [attachment])).rejects.toThrow(/balance is the total debt/);
    const runB = (await b.pool.query('SELECT id FROM payroll_run_headers WHERE company_id = $1 LIMIT 1', [b.company])).rows[0]!.id;
    await expect(a.pool.query(
      `INSERT INTO payroll_garnishee_deductions (company_id, run_id, order_id, employee_id, requested, amount) VALUES ($1, $2, $3, $4, 1, 1)`,
      [b.company, runB, attachment, empB])).rejects.toThrow(/not this company/);
  });
});
