/**
 * Review #1679e (OC x GA): an off-cycle run takes no garnishee instalment. The month's instalment is the regular
 * run's; a bonus or termination run with an order in force deducts nothing and its line says so (info,
 * GARNISHEE_TAKEN_BY_REGULAR_RUN). A R2 000 maintenance order: the regular run deducts R2 000, a R5 000 bonus run R0
 * (net as without the order), a termination run R0; the month's deductions stay R2 000.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';

vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let mid = '';
let bonusComponent = '';
let regular = '';

const create = (body: Record<string, unknown>) =>
  a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, ...body } });
const deducted = async (run: string) =>
  Number((await a.pool.query('SELECT COALESCE(SUM(amount), 0)::float8 AS n FROM payroll_garnishee_deductions WHERE run_id = $1', [run])).rows[0].n);
const line = async (run: string) => (await a.pool.query(
  'SELECT net_pay::float8 AS net, gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif, validation_results AS v FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2',
  [run, mid])).rows[0];
async function calculated(made: { statusCode: number; body: { data?: { id?: unknown } } }): Promise<string> {
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  expect((await a.api.calculate(id)).statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  a = await rig('w6-oc-garnishee');
  await a.setup();
  mid = (await a.employee(15_000)).employee;
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const payable = (await a.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '2175'`, [a.company])).rows[0].id;
  // An order is written by a session user (999z): as app_user with the admin's claims, as the app writes it.
  const c = await a.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated', aal: 'aal2' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
    await c.query(`INSERT INTO payroll_garnishee_orders (company_id, employee_id, kind, reference, creditor_name, instalment, start_date, payable_account_id, created_by)
      VALUES ($1, $2, 'maintenance', 'MAINT-1', 'Maintenance creditor', 2000, '2026-01-01', $3, $4)`, [a.company, mid, payable, a.admin]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
  regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  // The deductions' guard keeps an approved run's rows: unapprove, unapply, then delete (as w6-garnishee does).
  await a.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [a.company]);
  await a.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('garnishee instalments belong to the regular run', () => {
  it('the regular run deducts the month\'s R2 000; a bonus run deducts nothing and says so', async () => {
    expect(await deducted(regular)).toBe(2_000);
    const bonus = await calculated(await create({ reason: 'bonus', runDate: '2026-11-27', employees: [{ employeeId: mid, componentId: bonusComponent, amount: 5_000 }] }));
    expect(await deducted(bonus)).toBe(0);
    const l = await line(bonus);
    // Net is the bonus less its own PAYE and UIF only: no instalment came off it.
    expect(l.net).toBeCloseTo(l.gross - l.paye - l.uif, 2);
    expect((l.v as Array<{ code: string; severity: string; message: string }>).find((w) => w.code === 'GARNISHEE_TAKEN_BY_REGULAR_RUN'))
      .toMatchObject({ severity: 'info', message: expect.stringMatching(/Maintenance creditor \(MAINT-1\)\. Garnishee instalments are taken by the regular run/) });
    const ok = await a.api.approve(bonus);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(await deducted(regular) + await deducted(bonus)).toBe(2_000);
  });

  it('a termination run deducts nothing either', async () => {
    await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-25', termination_reason = 'resignation',
      termination_notice_period_days = 10, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [mid]);
    const term = await calculated(await create({ reason: 'termination', runDate: '2026-11-28', employees: [{ employeeId: mid }] }));
    expect(await deducted(term)).toBe(0);
    expect((await line(term)).v.map((w: { code: string }) => w.code)).toContain('GARNISHEE_TAKEN_BY_REGULAR_RUN');
  });
});
