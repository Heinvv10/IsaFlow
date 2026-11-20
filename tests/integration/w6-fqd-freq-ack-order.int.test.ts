/**
 * Wave 6 FQd, breaker #1622 M-F (coordinator ruling, both parts). Monthly to weekly, February paid monthly; the weekly
 * run B (6-12 Apr) is acknowledged first (its once-off settled 1 Mar - 5 Apr), then a weekly run A (9-15 Mar) comes.
 *  (1) Once B is approved holding the acknowledgement, no weekly run starting before B is created (409, naming B), nor
 *      calculated (a run already there, as one made before this rule), naming B.
 *  (2) While B is not yet approved, A (now the earliest weekly run) is judged against B's acknowledgement too: it would
 *      pay 9-15 Mar, which B's once-off settled, so it is refused, and nothing can be acknowledged on it.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import straddleRoute from '../../pages/api/payroll/runs/[id]/frequency-change';
import { setEmployeePayFrequency } from '@/modules/accounting/services/payroll/payrollEmployeePayFrequency';

const create = (r: R, body: unknown) => r.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body });
const ack = (r: R, run: string, employeeId: string) =>
  r.call(straddleRoute as Route, 'POST', `/api/payroll/runs/${run}/frequency-change`, run, { body: { employeeId } });
const nameOf = async (r: R, employee: string) =>
  String((await r.pool.query("SELECT first_name || ' ' || last_name AS n FROM payroll_employees WHERE id = $1", [employee])).rows[0]!.n);

/** February paid monthly, the employee moved to weekly from 1 March, and B (6-12 Apr) acknowledged. */
async function setUp(r: R): Promise<{ employee: string; name: string; runB: string }> {
  const { employee } = await r.employee(20000);
  const feb = String((await create(r, { month: 2, year: 2026 })).body.data!.id);
  expect((await r.api.calculate(feb)).statusCode).toBe(200);
  expect((await r.api.approve(feb)).statusCode).toBe(200);
  await setEmployeePayFrequency(r.company, employee, 'weekly',
    { userId: r.admin, userEmail: `${r.admin}@test.local`, ip: null, userAgent: null, sessionId: null } as never, true, '2026-03-01');
  const runB = String((await create(r, { frequency: 'weekly', periodStart: '2026-04-06' })).body.data!.id);
  expect((await r.api.calculate(runB)).statusCode).toBe(409);
  expect((await ack(r, runB, employee)).statusCode).toBe(200);
  return { employee, name: await nameOf(r, employee), runB };
}

const AFTER_B = (name: string) => `${name}'s change to weekly pay was acknowledged on the approved weekly run for 6–12 Apr 2026, `
  + 'whose once-off settled the days before it. A weekly run starting 9 Mar 2026 comes before that run and would pay those days again.';

describe('(1) a weekly run before an APPROVED acknowledged run', () => {
  let a: R;
  let s: { employee: string; name: string; runB: string };
  beforeAll(async () => {
    a = await rig('fqd-ack-order-1');
    await a.setup();
    s = await setUp(a);
    expect((await a.api.calculate(s.runB)).statusCode).toBe(200);
    expect((await a.api.approve(s.runB)).statusCode).toBe(200);
  }, 240_000);
  afterAll(async () => { await cleanup(a); });

  it('is not created: 409, naming the approved run', async () => {
    const res = await create(a, { frequency: 'weekly', periodStart: '2026-03-09' });
    expect([res.statusCode, a.msg(res)]).toEqual([409, AFTER_B(s.name)]);
    expect((await a.pool.query("SELECT count(*)::int n FROM payroll_run_headers WHERE company_id = $1 AND period_start = '2026-03-09'", [a.company])).rows[0]!.n).toBe(0);
  });

  it('a run already there is not calculated: 409 FREQUENCY_CHANGE_STRADDLE, naming the approved run', async () => {
    const runA = String((await a.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind, period_start, period_end, run_date)
       VALUES ($1, 3, 2026, 'weekly', 'regular', '2026-03-09', '2026-03-15', '2026-03-15') RETURNING id`, [a.company])).rows[0]!.id);
    const res = await a.api.calculate(runA);
    expect([res.statusCode, res.body.error?.details?.code, a.msg(res)]).toEqual([409, 'FREQUENCY_CHANGE_STRADDLE', AFTER_B(s.name)]);
    expect((await ack(a, runA, s.employee)).statusCode).toBe(409);
  });

  it('a weekly run after B is created as usual', async () => {
    expect((await create(a, { frequency: 'weekly', periodStart: '2026-04-13' })).statusCode).toBe(201);
  });
});

describe('(2) a weekly run paying days another run\'s acknowledgement settled', () => {
  let a: R;
  let s: { employee: string; name: string; runB: string };
  beforeAll(async () => {
    a = await rig('fqd-ack-order-2');
    await a.setup();
    s = await setUp(a);
  }, 240_000);
  afterAll(async () => { await cleanup(a); });

  it('A, created while B is not approved, is refused for 9-15 Mar, naming B, and cannot be acknowledged', async () => {
    const created = await create(a, { frequency: 'weekly', periodStart: '2026-03-09' });
    expect(created.statusCode).toBe(201);
    const runA = String(created.body.data!.id);
    const res = await a.api.calculate(runA);
    expect([res.statusCode, a.msg(res)]).toEqual([409, `${s.name}'s days 9–15 Mar 2026 were settled with a once-off when the change was `
      + 'acknowledged on the weekly run for 6–12 Apr 2026: this run cannot pay them again.']);
    expect((await ack(a, runA, s.employee)).statusCode).toBe(409);
  });
});
