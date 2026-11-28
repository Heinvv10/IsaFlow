/**
 * Wave 7 GT (W11; rulings 6, 15; grill F12): a garnishee order on an off-cycle termination run, through the real routes
 * (withAuth, app_user, RLS), on two tenants (B at 10x the amounts, in a later month).
 * Claims:
 *  - an order the month's regular run did not take is deducted from the termination line's notice pay (25% cap), the
 *    line warns GARNISHEE_ON_TERMINATION, and the balance does not move at calculate;
 *  - approval marks the balance and posts a balanced journal whose garnishee payable credit equals the deduction;
 *  - a regular run recalculated while the termination run is final skips the order (GARNISHEE_TAKEN_THIS_MONTH);
 *  - approval refuses (nothing written) a run deducting an order another final run of the month took since it was costed,
 *    and a run that skipped an order whose taker was reopened;
 *  - reopen restores the balance; cancelling a calculated termination run drops its deductions, balance unchanged.
 * The clock is SAST 2026-11-17 (Date only, advancing). Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Res, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import cancel from '../../pages/api/payroll/runs/[id]/cancel';
import { loadRunGarnisheeOrders } from '@/modules/accounting/services/payroll/payrollGarnisheeRun';
import { judgeMonthGarnishees } from '@/modules/accounting/services/payroll/payrollGarnisheeMonth';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

type Rig = Awaited<ReturnType<typeof rig>>;
let a: Rig;
let b: Rig;
const t = { leaver: '', other: '', order: '', otherOrder: '', regular: '', term: '' };
const tb = { leaver: '', order: '', regular: '', term: '' };

const create = (r: Rig, month: number, runDate: string, employeeId: string) =>
  r.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month, year: 2026, reason: 'termination', runDate, employees: [{ employeeId }] } });
const ok = (x: Res, code = 200) => expect(x.statusCode, JSON.stringify(x.body)).toBe(code);
const deduction = async (r: Rig, run: string, order: string) => (await r.pool.query(
  'SELECT amount::float8 AS amount, balance_applied FROM payroll_garnishee_deductions WHERE run_id = $1 AND order_id = $2', [run, order])).rows[0] ?? null;
const balance = async (r: Rig, order: string) => Number((await r.pool.query('SELECT balance::float8 AS b FROM payroll_garnishee_orders WHERE id = $1', [order])).rows[0].b);
const codes = async (r: Rig, run: string, employee: string) => ((await r.pool.query(
  'SELECT validation_results AS v FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, employee])).rows[0]?.v ?? []) as Array<{ code: string; severity: string; message: string; orders?: string[] }>;
const line = async (r: Rig, run: string, employee: string) => (await r.pool.query(
  'SELECT gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif, net_pay::float8 AS net FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2',
  [run, employee])).rows[0]!;

/** An order as the app writes it: a session user (999z), as app_user with the admin's claims. */
async function order(r: Rig, employee: string, kind: string, instalment: number, totalDebt: number): Promise<string> {
  const payable = (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '2175'`, [r.company])).rows[0].id;
  const c = await r.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: r.admin, role: 'authenticated', aal: 'aal2' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [r.company]);
    const id = (await c.query(`INSERT INTO payroll_garnishee_orders (company_id, employee_id, kind, reference, creditor_name, instalment, total_debt, balance, start_date, payable_account_id, created_by)
      VALUES ($1, $2, $3, $4, 'GT creditor', $5, $6, $6, '2026-01-01', $7, $8) RETURNING id`,
    [r.company, employee, kind, `GT-${kind}-${instalment}`, instalment, totalDebt, payable, r.admin])).rows[0].id as string;
    await c.query('COMMIT');
    return id;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
const leaving = (r: Rig, employee: string, endDate: string) => r.pool.query(`UPDATE payroll_employees SET end_date = $2, termination_reason = 'resignation',
  termination_notice_period_days = 10, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [employee, endDate]);

/** The journal's lines: balanced, and its credit to the garnishee payable. */
async function journalOf(r: Rig, run: string): Promise<{ debit: number; credit: number; payable: number }> {
  const h = await r.header(run);
  const row = (await r.pool.query(
    `SELECT COALESCE(sum(l.debit), 0)::float8 AS debit, COALESCE(sum(l.credit), 0)::float8 AS credit,
            COALESCE(sum(l.credit - l.debit) FILTER (WHERE l.gl_account_id IN (SELECT payable_account_id FROM payroll_garnishee_orders WHERE company_id = $2)), 0)::float8 AS payable
       FROM gl_journal_lines l WHERE l.journal_entry_id = $1`, [h.journal_entry_id, r.company])).rows[0];
  return row as { debit: number; credit: number; payable: number };
}

beforeAll(async () => {
  a = await rig('w7-gt-a');
  b = await rig('w7-gt-b');
  await a.setup();
  await b.setup();
  t.leaver = (await a.employee(15_000)).employee;
  t.other = (await a.employee(12_000)).employee;
  tb.leaver = (await b.employee(150_000)).employee;
  // The month's regular runs are approved before any order exists (an off-cycle run needs one, payrollOffCycleRun).
  t.regular = await a.calculatedRun(11);
  ok(await a.api.approve(t.regular));
  tb.regular = await b.calculatedRun(12);
  ok(await b.api.approve(tb.regular));
  // Orders captured after the regular run: the termination run is the month's first to take them.
  t.order = await order(a, t.leaver, 'emolument_attachment', 1_000, 5_000);
  tb.order = await order(b, tb.leaver, 'emolument_attachment', 30_000, 300_000);
  await leaving(a, t.leaver, '2026-11-25');
  await leaving(b, tb.leaver, '2026-12-24');
}, 180_000);

afterAll(async () => {
  for (const r of [a, b].filter(Boolean)) {
    await r.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [r.company]);
    await r.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.teardown();
  }
  vi.useRealTimers();
}, 180_000);

describe('a termination run attaches leave and notice pay (W11)', () => {
  it('calculate deducts the order from the notice pay and warns; the balance does not move', async () => {
    const made = await create(a, 11, '2026-11-27', t.leaver);
    ok(made, 201);
    t.term = String(made.body.data!.id);
    ok(await a.api.calculate(t.term));
    const l = await line(a, t.term, t.leaver);
    expect(l.gross).toBeGreaterThan(4_000); // 10 days' notice pay on R15 000 a month: 25% of it is above the R1 000 instalment
    expect(await deduction(a, t.term, t.order)).toEqual({ amount: 1_000, balance_applied: false });
    expect(l.net).toBeCloseTo(l.gross - l.paye - l.uif - 1_000, 2);
    const w = (await codes(a, t.term, t.leaver)).find((x) => x.code === 'GARNISHEE_ON_TERMINATION')!;
    expect(w).toMatchObject({ severity: 'warning', message: expect.stringMatching(/GT-emolument_attachment-1000 .*deducted from the leave and notice pay/) });
    expect(w.message).toMatch(/4\s000\.00 is still owed/);
    expect(await balance(a, t.order)).toBe(5_000);
  });

  it('tenant B, 10x and a month later: 25% of the notice pay caps the R30 000 instalment; A sees none of it', async () => {
    const made = await create(b, 12, '2026-12-28', tb.leaver);
    ok(made, 201);
    tb.term = String(made.body.data!.id);
    ok(await b.api.calculate(tb.term));
    const l = await line(b, tb.term, tb.leaver);
    const d = await deduction(b, tb.term, tb.order);
    expect(d.amount).toBeLessThan(30_000);
    expect(d.amount).toBeCloseTo(Math.floor(l.gross * 25) / 100, 2); // the line is notice pay only: base = gross
    expect((await codes(b, tb.term, tb.leaver)).map((x) => x.code)).toEqual(expect.arrayContaining(['GARNISHEE_LIMIT_APPLIED', 'GARNISHEE_ON_TERMINATION']));
    // Tenant isolation: A's routes cannot reach B's run.
    expect((await a.api.calculate(tb.term)).statusCode).toBeGreaterThanOrEqual(400);
    ok(await b.api.approve(tb.term));
    expect(await balance(b, tb.order)).toBeCloseTo(300_000 - d.amount, 2);
    expect(await balance(a, t.order)).toBe(5_000);
    const j = await journalOf(b, tb.term);
    expect(j.debit).toBeCloseTo(j.credit, 2);
    expect(j.payable).toBeCloseTo(d.amount, 2);
  });

  it('approval marks the balance and posts a balanced journal whose payable credit is the deduction', async () => {
    ok(await a.api.approve(t.term));
    expect(await deduction(a, t.term, t.order)).toEqual({ amount: 1_000, balance_applied: true });
    expect(await balance(a, t.order)).toBe(4_000);
    const j = await journalOf(a, t.term);
    expect(j.debit).toBeGreaterThan(0);
    expect(j.debit).toBeCloseTo(j.credit, 2);
    expect(j.payable).toBeCloseTo(1_000, 2);
  });

  // The regular run cannot be reopened while the month's termination run is final (laterOffCycleRefusal), so the
  // "regular skips" direction is held by the loader itself: proved on the real SQL, the runs as the routes left them.
  it('the loader marks the order taken for the month\'s regular run while the termination run is final (F12 both ways)', async () => {
    expect((await a.api.reopen(t.regular)).statusCode).toBe(400); // the route refuses: reopen the termination run first
    const forRegular = await loadRunGarnisheeOrders(a.company, [t.leaver], '2026-11-01', '2026-11-30', t.regular);
    expect(forRegular.get(t.leaver)).toEqual([expect.objectContaining({ id: t.order, takenThisMonth: true })]);
    const forItself = await loadRunGarnisheeOrders(a.company, [t.leaver], '2026-11-01', '2026-11-30', t.term);
    expect(forItself.get(t.leaver)).toEqual([expect.objectContaining({ id: t.order, takenThisMonth: false })]);
  });

  it('approval refuses a skip whose taker is no longer final (real SQL on the stored line)', async () => {
    // The regular line as a calculation would have stored it while the termination run was final.
    const original = (await a.pool.query('SELECT validation_results FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [t.regular, t.leaver])).rows[0].validation_results;
    await a.pool.query(`UPDATE payroll_run_lines SET validation_results = validation_results || $3::jsonb WHERE run_id = $1 AND employee_id = $2`,
      [t.regular, t.leaver, JSON.stringify([{ code: 'GARNISHEE_TAKEN_THIS_MONTH', severity: 'info', message: 'x', orders: [t.order] }])]);
    await expect(judgeMonthGarnishees(a.company, t.regular)).resolves.toBeUndefined();
    ok(await a.api.reopen(t.term));
    expect(await balance(a, t.order)).toBe(5_000); // reopen restored it
    expect(await deduction(a, t.term, t.order)).toEqual({ amount: 1_000, balance_applied: false });
    await expect(judgeMonthGarnishees(a.company, t.regular)).rejects.toThrow(/no longer approved, so no run of the month deducts it/);
    await a.pool.query('UPDATE payroll_run_lines SET validation_results = $3::jsonb WHERE run_id = $1 AND employee_id = $2', [t.regular, t.leaver, JSON.stringify(original)]);
  });

  it('approval refuses, writing nothing, a deduction another final run of the month took since it was costed', async () => {
    // The termination run (reopened) still holds its R1 000; the regular run is reopened, now takes the order, and is approved first.
    ok(await a.api.reopen(t.regular));
    ok(await a.api.calculate(t.regular));
    expect(await deduction(a, t.regular, t.order)).toEqual({ amount: 1_000, balance_applied: false });
    ok(await a.api.reverse(String((await a.header(t.regular)).journal_entry_id))); // the recalculated run posts a new journal
    ok(await a.api.approve(t.regular));
    expect(await balance(a, t.order)).toBe(4_000);
    await expect(judgeMonthGarnishees(a.company, t.term)).rejects.toThrow(/deducted by another approved run of this month .* twice/);
    const before = await a.header(t.term);
    const refused = await a.api.approve(t.term);
    expect(refused.statusCode, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
    expect(await a.header(t.term)).toEqual(before);
    expect(await deduction(a, t.term, t.order)).toEqual({ amount: 1_000, balance_applied: false });
    expect(await balance(a, t.order)).toBe(4_000);
    // Recalculated, the termination run skips the order the regular run took (ruling 15), and approves.
    ok(await a.api.calculate(t.term));
    expect(await deduction(a, t.term, t.order)).toBeNull();
    expect((await codes(a, t.term, t.leaver)).find((x) => x.code === 'GARNISHEE_TAKEN_THIS_MONTH'))
      .toMatchObject({ severity: 'info', orders: [t.order], message: expect.stringMatching(/regular run/) });
    ok(await a.api.reverse(String((await a.header(t.term)).journal_entry_id)));
    ok(await a.api.approve(t.term));
    const j = await journalOf(a, t.term);
    expect(j.payable).toBeCloseTo(0, 2); // nothing deducted, nothing owed to the creditor from this run
    expect(await balance(a, t.order)).toBe(4_000); // one instalment in the month
  });

  it('cancelling a calculated termination run drops its deductions; the balance never moved', async () => {
    t.otherOrder = await order(a, t.other, 'maintenance', 800, 3_000); // after the regular run's last approval
    await leaving(a, t.other, '2026-11-25'); // also after it: the regular run paid no termination pay-outs for them
    const made = await create(a, 11, '2026-11-28', t.other);
    ok(made, 201);
    const id = String(made.body.data!.id);
    ok(await a.api.calculate(id));
    expect(await deduction(a, id, t.otherOrder)).toEqual({ amount: 800, balance_applied: false });
    const done = await a.call(cancel as Route, 'POST', `/api/payroll/runs/${id}/cancel`, id);
    ok(done);
    expect((await a.header(id)).status).toBe('cancelled');
    expect(await deduction(a, id, t.otherOrder)).toBeNull();
    expect(await balance(a, t.otherOrder)).toBe(3_000);
  });
});
