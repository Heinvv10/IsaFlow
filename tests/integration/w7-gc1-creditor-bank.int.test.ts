/**
 * The creditor's bank details on a garnishee order (wave 7 GC1, migration 1051) through the real routes, withAuth,
 * app_user and RLS, on two tenants. Claims:
 *  - a manager makes the first entry, except on an order that is ended or that an approved run has deducted (403
 *    FIRST_ENTRY_REQUIRES_ADMIN, nothing written; the trigger refuses it as app_user too, on both arms); the
 *    "deducted by an approved run" fact (creditor_entry_admin_only) is set at approval and survives a reopen, a
 *    recalculation that takes nil and the deletion of the deduction (team review #1895 B0, B1; breaker R1, R2);
 *  - the table refuses an order inserted with creditor details, stamps or the flag prefilled, whoever writes it, and a
 *    stamp written alone keeps the old stamp (B2; breaker R5); another employee's id with the order's id is 404 (R3);
 *  - a change by a manager is 403 CHANGE_REQUIRES_ADMIN and writes nothing; an owner /
 *    admin changes them; the same details again write nothing;
 *  - refusals (bad values, an extra key, another tenant's order, a viewer) change no row and write no audit row;
 *  - the list and the PUT answer are masked for everyone; a full GET is owner / admin only and writes one `export`
 *    audit row naming the fields; a manager's GET is masked and writes none; no audit row holds a full number;
 *  - the table: the trigger stamps who and when from the session, refuses a manager's change and a removal as app_user,
 *    and the CHECK refuses half an account.
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import orders from '../../pages/api/payroll/employees/[id]/garnishee-orders/index';
import orderRoute from '../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';
import { rig, type Res, type Route } from './brkr.helpers';

type R = Awaited<ReturnType<typeof rig>>;
let a: R;
let b: R;
let emp = '';
let empB = '';
let orderA = '';
let orderB = '';
let manager = '';

const ORDER = {
  kind: 'emolument_attachment', reference: 'EAO 1/2027', creditorName: 'Acme Credit', instalment: 60000, totalDebt: 100000,
  startDate: '2027-01-01', endDate: null, priority: 10,
};
const BANK = { bankName: 'First National Bank', branchCode: '250655', accountNumber: '62001234567', accountType: 'cheque', accountHolder: 'Acme Credit Ltd' };
const OTHER = { ...BANK, bankName: 'Standard Bank', branchCode: '051001', accountNumber: '10098765432', accountHolder: 'Acme Collections' };

const at = (r: R, employee: string, order: string, method: string, o: { body?: unknown; user?: string; company?: string; view?: string } = {}) => {
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId: order, ...(o.view ? { view: o.view } : {}) };
    return (orderRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  return r.call(route, method, `/api/payroll/employees/${employee}/garnishee-orders/${order}`, employee, o);
};
const list = (r: R, employee: string, o: { user?: string } = {}) =>
  r.call(orders as Route, 'GET', `/api/payroll/employees/${employee}/garnishee-orders`, employee, o);
const reason = (x: Res) => x.body.error?.details?.reason as string | undefined;
const stored = async (r: R, id: string) => (await r.pool.query(
  `SELECT creditor_bank_name, creditor_branch_code, creditor_account_number, creditor_account_type, creditor_account_holder,
          creditor_bank_set_by, creditor_bank_set_at IS NOT NULL AS stamped
     FROM payroll_garnishee_orders WHERE id = $1`, [id])).rows[0]!;
const audits = async (r: R, id: string) => (await r.pool.query(
  "SELECT action, user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_garnishee_order' AND entity_id = $2 AND action IN ('update', 'export') ORDER BY created_at, id",
  [r.company, id])).rows as Array<{ action: string; user_id: string; changes: { fields: Array<{ field: string; old: string | null; new: string | null }>; metadata?: Record<string, string> } }>;

beforeAll(async () => {
  a = await rig('gc1-a');
  b = await rig('gc1-b');
  await a.setup();
  await b.setup();
  emp = (await a.employee(200000)).employee;
  empB = (await b.employee(300000)).employee;
  manager = await a.addUser('manager');
  const made = await a.call(orders as Route, 'POST', `/api/payroll/employees/${emp}/garnishee-orders`, emp, { body: ORDER });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  orderA = String(made.body.data!.id);
  const madeB = await b.call(orders as Route, 'POST', `/api/payroll/employees/${empB}/garnishee-orders`, empB, { body: ORDER });
  expect(madeB.statusCode).toBe(201);
  orderB = String(madeB.body.data!.id);
}, 120_000);
afterAll(async () => {
  for (const r of [a, b].filter(Boolean)) {
    // The deductions' guard keeps an approved run's rows: unapprove, unapply, then delete (as w6-garnishee does).
    await r.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [r.company]);
    await r.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [r.company]);
    await r.teardown();
  }
});

describe('garnishee creditor bank details', () => {
  it('refuses, writing nothing: bad values, an extra key, another tenant, a viewer', async () => {
    const bad = await at(a, emp, orderA, 'PUT', { body: { ...BANK, branchCode: '2506' } });
    expect(bad.statusCode).toBe(422);
    expect((await at(a, emp, orderA, 'PUT', { body: { ...BANK, accountNumber: '12ab' } })).statusCode).toBe(422);
    expect((await at(a, emp, orderA, 'PUT', { body: { ...BANK, accountType: 'credit' } })).statusCode).toBe(422);
    expect((await at(a, emp, orderA, 'PUT', { body: { ...BANK, extra: 1 } })).statusCode).toBe(400);
    const cross = await at(b, emp, orderA, 'PUT', { body: BANK });
    expect([cross.statusCode, reason(cross)]).toEqual([404, 'ORDER_NOT_FOUND']);
    expect((await at(b, emp, orderA, 'GET')).statusCode).toBe(404);
    // B's own employee with A's order id: still not found (the order is scoped by company and employee).
    expect((await at(b, empB, orderA, 'PUT', { body: BANK })).statusCode).toBe(404);
    const viewer = await a.addUser('viewer');
    expect((await at(a, emp, orderA, 'PUT', { body: BANK, user: viewer })).statusCode).toBe(403);
    expect(await stored(a, orderA)).toMatchObject({ creditor_account_number: null, creditor_bank_set_by: null, stamped: false });
    expect(await audits(a, orderA)).toEqual([]);
  });

  it('a manager makes the first entry: stored in full, stamped, answered masked, audited masked', async () => {
    const put = await at(a, emp, orderA, 'PUT', { body: BANK, user: manager });
    expect(put.statusCode, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject({ bankName: 'First National Bank', accountNumber: '…4567', branchCode: '…55', accountHolder: 'A…', masked: true });
    expect(await stored(a, orderA)).toMatchObject({
      creditor_bank_name: 'First National Bank', creditor_branch_code: '250655', creditor_account_number: '62001234567',
      creditor_account_type: 'cheque', creditor_account_holder: 'Acme Credit Ltd', creditor_bank_set_by: manager, stamped: true,
    });
    const rows = await audits(a, orderA);
    expect(rows.map((x) => [x.action, x.user_id])).toEqual([['update', manager]]);
    const fields = Object.fromEntries(rows[0]!.changes.fields.map((f) => [f.field, [f.old, f.new]]));
    expect(fields.creditor_account_number).toEqual([null, '…4567']);
    expect(fields.creditor_branch_code).toEqual([null, '…55']);
    expect(fields.creditor_account_holder).toEqual([null, 'A…']);
    expect(JSON.stringify(rows)).not.toContain('62001234567');
    expect(JSON.stringify(rows)).not.toContain('250655');
  });

  it('a manager\'s change is 403 and writes nothing; the same details again write nothing', async () => {
    const refused = await at(a, emp, orderA, 'PUT', { body: OTHER, user: manager });
    expect([refused.statusCode, reason(refused)]).toEqual([403, 'CHANGE_REQUIRES_ADMIN']);
    // Unchanged details from a manager are refused too: the role is decided before the comparison.
    expect((await at(a, emp, orderA, 'PUT', { body: BANK, user: manager })).statusCode).toBe(403);
    const again = await at(a, emp, orderA, 'PUT', { body: BANK });
    expect(again.statusCode).toBe(200);
    expect(await stored(a, orderA)).toMatchObject({ creditor_account_number: '62001234567', creditor_bank_set_by: manager });
    expect(await audits(a, orderA)).toHaveLength(1);
  });

  it('an admin changes them; the audit row shows both sides masked', async () => {
    const put = await at(a, emp, orderA, 'PUT', { body: OTHER });
    expect(put.statusCode).toBe(200);
    expect(await stored(a, orderA)).toMatchObject({ creditor_account_number: '10098765432', creditor_bank_set_by: a.admin });
    const last = (await audits(a, orderA)).at(-1)!;
    const fields = Object.fromEntries(last.changes.fields.map((f) => [f.field, [f.old, f.new]]));
    expect(fields.creditor_account_number).toEqual(['…4567', '…5432']);
    expect(fields.creditor_bank_name).toEqual(['First National Bank', 'Standard Bank']);
    expect(JSON.stringify(last)).not.toContain('10098765432');
  });

  it('reads: the list is masked; a full GET is admin-only and audited once; a manager\'s GET is masked and not audited', async () => {
    const listed = (await list(a, emp, { user: manager })).body.data!.orders as Array<{ id: string; creditorBank: Record<string, unknown> }>;
    expect(listed.find((o) => o.id === orderA)!.creditorBank).toMatchObject({ accountNumber: '…5432', masked: true });
    const before = (await audits(a, orderA)).length;
    const mgr = await at(a, emp, orderA, 'GET', { user: manager });
    expect(mgr.body.data).toMatchObject({ accountNumber: '…5432', branchCode: '…01', masked: true });
    const masked = await at(a, emp, orderA, 'GET', { view: 'masked' });
    expect(masked.body.data).toMatchObject({ masked: true });
    expect(await audits(a, orderA)).toHaveLength(before);
    const full = await at(a, emp, orderA, 'GET');
    expect(full.body.data).toMatchObject({ accountNumber: '10098765432', branchCode: '051001', accountHolder: 'Acme Collections', masked: false });
    const rows = await audits(a, orderA);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ action: 'export', user_id: a.admin });
    expect(rows.at(-1)!.changes.metadata).toMatchObject({ revealed: 'creditor_account_number,creditor_branch_code,creditor_account_holder', employeeId: emp });
    // B's order is untouched by all of A's writes.
    expect(await stored(b, orderB)).toMatchObject({ creditor_account_number: null });
  });

  it('the table: as app_user a manager cannot change or remove them; the CHECK refuses half an account', async () => {
    const asUser = async (user: string, q: string) => {
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
        await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
        return await c.query(q, [orderA]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    await expect(asUser(manager, "UPDATE payroll_garnishee_orders SET creditor_account_number = '99999999' WHERE id = $1"))
      .rejects.toThrow(/only an owner or admin changes creditor bank details/);
    await expect(asUser(a.admin, `UPDATE payroll_garnishee_orders SET creditor_account_number = NULL, creditor_bank_name = NULL,
      creditor_branch_code = NULL, creditor_account_type = NULL, creditor_account_holder = NULL WHERE id = $1`))
      .rejects.toThrow(/replaced, never removed/);
    const stamped = await asUser(a.admin, "UPDATE payroll_garnishee_orders SET creditor_account_number = '99999999' WHERE id = $1 RETURNING creditor_bank_set_by");
    expect(stamped.rows[0]!.creditor_bank_set_by).toBe(a.admin);
    // No session user (the owner pool, no claims): refused by the trigger before any CHECK.
    await expect(a.pool.query("UPDATE payroll_garnishee_orders SET creditor_account_number = '88888888' WHERE id = $1", [orderA]))
      .rejects.toThrow(/need a session user/);
    // Half an account, the trigger off: the CHECK alone refuses it.
    const c = await b.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE payroll_garnishee_orders DISABLE TRIGGER payroll_garnishee_creditor_bank_guard');
      await expect(c.query("UPDATE payroll_garnishee_orders SET creditor_account_number = '12345678' WHERE id = $1", [orderB]))
        .rejects.toThrow(/payroll_garnishee_orders_creditor_bank/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(await stored(a, orderA)).toMatchObject({ creditor_account_number: '10098765432' });
  });


  /** One employee, one order of its own (so no other order eats the s65J 25% limit), deducted by an approved run of
   *  `month` 2026 (tax year 2027: the newest tables loaded; orderA starts in 2027, so it is not in these runs). */
  async function deductedOrder(month: number, ref: string): Promise<{ employee: string; order: string; run: string }> {
    const employee = (await a.employee(200000)).employee;
    const made = await a.call(orders as Route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders`, employee,
      { body: { ...ORDER, reference: ref, instalment: 10000, totalDebt: 500000, startDate: `2026-${String(month).padStart(2, '0')}-01` } });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const order = String(made.body.data!.id);
    const run = await a.calculatedRun(month, 2026);
    // B0: the rule below is only tested if the run really deducted this order.
    const rows = (await a.pool.query('SELECT amount::float8 AS amount FROM payroll_garnishee_deductions WHERE order_id = $1 AND run_id = $2', [order, run])).rows;
    expect(rows).toEqual([{ amount: 10000 }]);
    const approved = await a.api.approve(run);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
    return { employee, order, run };
  }
  const flag = async (order: string) => (await a.pool.query('SELECT creditor_entry_admin_only AS f FROM payroll_garnishee_orders WHERE id = $1', [order])).rows[0]!.f as boolean;
  const asManager = async (q: (c: { query: (s: string, p?: unknown[]) => Promise<unknown> }) => Promise<unknown>, user = manager) => {
    const c = await a.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
      return await q(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  };
  const FIRST = `UPDATE payroll_garnishee_orders SET creditor_bank_name = 'FNB', creditor_branch_code = '250655',
    creditor_account_number = '62001234567', creditor_account_type = 'cheque' WHERE id = $1`;

  it('B0/B1/R1: approval sets the flag; a manager\'s first entry is refused, and still after a reopen and a nil recalculation', async () => {
    const { employee, order, run } = await deductedOrder(11, 'EAO 11/2026');
    expect(await flag(order)).toBe(true);
    const refused = await at(a, employee, order, 'PUT', { body: BANK, user: manager });
    expect([refused.statusCode, reason(refused)]).toEqual([403, 'FIRST_ENTRY_REQUIRES_ADMIN']);
    expect(await stored(a, order)).toMatchObject({ creditor_account_number: null, stamped: false });
    expect(await audits(a, order)).toEqual([]);
    // R1: reopen, then a higher-priority order takes the whole 25% limit, so the recalculation records nothing for it.
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    const big = await a.call(orders as Route, 'POST', `/api/payroll/employees/${employee}/garnishee-orders`, employee,
      { body: { ...ORDER, reference: 'EAO 11b/2026', instalment: 900000, totalDebt: null, priority: 1, startDate: '2026-11-01' } });
    expect(big.statusCode).toBe(201);
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    expect((await a.pool.query('SELECT 1 FROM payroll_garnishee_deductions WHERE order_id = $1', [order])).rows).toEqual([]);
    expect(await flag(order)).toBe(true);
    const still = await at(a, employee, order, 'PUT', { body: BANK, user: manager });
    expect([still.statusCode, reason(still)]).toEqual([403, 'FIRST_ENTRY_REQUIRES_ADMIN']);
    // An owner / admin may.
    expect((await at(a, employee, order, 'PUT', { body: BANK })).statusCode).toBe(200);
    expect(await stored(a, order)).toMatchObject({ creditor_account_number: '62001234567', creditor_bank_set_by: a.admin });
  });

  it('R2/T2 (flag arm): as app_user, deleting the reopened run\'s deduction does not open the first entry; the flag never clears', async () => {
    const { order, run } = await deductedOrder(12, 'EAO 12/2026');
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    await expect(asManager(async (c) => {
      const del = (await c.query('DELETE FROM payroll_garnishee_deductions WHERE order_id = $1 RETURNING id', [order])) as { rows: unknown[] };
      expect(del.rows).toHaveLength(1);
      return c.query(FIRST, [order]);
    })).rejects.toThrow(/ended or approved-deducted order/);
    await expect(asManager((c) => c.query('UPDATE payroll_garnishee_orders SET creditor_entry_admin_only = false WHERE id = $1', [order]), a.admin))
      .rejects.toThrow(/never cleared/);
    expect(await flag(order)).toBe(true);
  });

  it('T2 (ended arm): an ended order\'s first entry is the admin\'s, through the route and the trigger', async () => {
    const made = await a.call(orders as Route, 'POST', `/api/payroll/employees/${emp}/garnishee-orders`, emp,
      { body: { ...ORDER, reference: 'EAO 12/2027', startDate: '2027-12-01' } });
    const ended = String(made.body.data!.id);
    expect((await at(a, emp, ended, 'POST', { body: { endDate: '2027-12-31', reason: 'Order rescinded by the court' } })).statusCode).toBe(200);
    expect(await flag(ended)).toBe(false);
    const refused = await at(a, emp, ended, 'PUT', { body: BANK, user: manager });
    expect([refused.statusCode, reason(refused)]).toEqual([403, 'FIRST_ENTRY_REQUIRES_ADMIN']);
    await expect(asManager((c) => c.query(FIRST, [ended]))).rejects.toThrow(/ended or approved-deducted order/);
    expect(await stored(a, ended)).toMatchObject({ creditor_account_number: null });
    expect((await at(a, emp, ended, 'PUT', { body: BANK })).statusCode).toBe(200);
  });

  it('R3: another employee of the same company, with this order\'s id, is 404 on GET and PUT', async () => {
    const other = (await a.employee(100000)).employee;
    expect((await at(a, other, orderA, 'PUT', { body: BANK })).statusCode).toBe(404);
    expect((await at(a, other, orderA, 'GET')).statusCode).toBe(404);
  });

  it('B2/R5: an order inserted with creditor details, stamps or the flag is refused whoever writes it; a stamp alone keeps the old', async () => {
    const insert = (extra: string, value: string) => a.pool.query(
      `INSERT INTO payroll_garnishee_orders (company_id, employee_id, kind, reference, creditor_name, instalment, total_debt, balance,
         start_date, payable_account_id, created_by, ${extra})
       SELECT company_id, employee_id, kind, 'R5', creditor_name, instalment, total_debt, total_debt, start_date, payable_account_id, created_by, ${value}
         FROM payroll_garnishee_orders WHERE id = $1`, [orderA]);
    // As the table owner (no grant applies): the trigger alone refuses.
    await expect(insert('creditor_account_number', "'99990000333'")).rejects.toThrow(/entered without creditor bank details/);
    await expect(insert('creditor_bank_set_by', "'FORGED-OWNER-ID'")).rejects.toThrow(/entered without creditor bank details/);
    await expect(insert('creditor_entry_admin_only', 'true')).rejects.toThrow(/entered without creditor bank details/);
    const before = await stored(a, orderA);
    const forged = await a.pool.query(
      "UPDATE payroll_garnishee_orders SET creditor_bank_set_by = 'forged', creditor_bank_set_at = '2020-01-01' WHERE id = $1 RETURNING creditor_bank_set_by",
      [orderA]);
    expect(forged.rows[0]!.creditor_bank_set_by).toBe(before.creditor_bank_set_by);
  });
});
