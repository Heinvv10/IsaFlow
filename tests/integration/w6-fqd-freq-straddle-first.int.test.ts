/**
 * Wave 6 FQd, breaker #1622 M-C: a frequency change is judged on the employee's EARLIEST run at the new frequency.
 *  - Monthly to weekly (February paid monthly): weekly runs for 9-15 Mar (A) and 6-12 Apr (B). B is refused until A is
 *    calculated, naming A; nothing can be acknowledged on B; A's gap (1-8 Mar) is refused until acknowledged on A, then
 *    A calculates and approves, and B, judged no more, follows. An acknowledgement on a later run can no longer let an
 *    earlier run pay the settled days again.
 *  - Weekly to fortnightly (weekly paid to Sun 1 Mar 2026): the fortnight from 23 Mar waits for the fortnight from 9 Mar,
 *    whose gap (2-8 Mar) is acknowledged on it.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import payWeek from '../../pages/api/payroll/settings/pay-week';
import straddleRoute from '../../pages/api/payroll/runs/[id]/frequency-change';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { setEmployeePayFrequency } from '@/modules/accounting/services/payroll/payrollEmployeePayFrequency';

let a: R;
let b: R;
const create = (r: R, body: unknown) => r.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body });
const ack = (r: R, run: string, employeeId: string) =>
  r.call(straddleRoute as Route, 'POST', `/api/payroll/runs/${run}/frequency-change`, run, { body: { employeeId } });
const id = (res: { body: { data?: { id?: unknown } } }) => String(res.body.data!.id);
const nameOf = async (r: R, employee: string) =>
  String((await r.pool.query("SELECT first_name || ' ' || last_name AS n FROM payroll_employees WHERE id = $1", [employee])).rows[0]!.n);
const actor = (r: R) => ({ userId: r.admin, userEmail: `${r.admin}@test.local`, ip: undefined, userAgent: undefined, sessionId: null });
async function paid(r: R, run: string): Promise<void> {
  const c = await r.api.calculate(run);
  expect(c.statusCode, r.msg(c)).toBe(200);
  const ap = await r.api.approve(run);
  expect(ap.statusCode, r.msg(ap)).toBe(200);
}

beforeAll(async () => {
  a = await rig('fqd-first-a');
  b = await rig('fqd-first-b');
  await a.setup();
  await b.setup();
}, 120_000);
afterAll(async () => { await cleanup(a); await cleanup(b); });

describe('the change is judged on the earliest run at the new frequency', () => {
  it('monthly to weekly: a later run waits for the first; the gap is acknowledged on the first run only', async () => {
    const { employee } = await a.employee(20000);
    await paid(a, id(await create(a, { month: 2, year: 2026 })));
    expect(await setEmployeePayFrequency(a.company, employee, 'weekly', actor(a), true, '2026-03-01')).toEqual({ payFrequency: 'weekly' });
    const runA = id(await create(a, { frequency: 'weekly', periodStart: '2026-03-09' }));
    const runB = id(await create(a, { frequency: 'weekly', periodStart: '2026-04-06' }));
    const name = await nameOf(a, employee);
    const bRefused = await a.api.calculate(runB);
    expect([bRefused.statusCode, bRefused.body.error?.details?.code, a.msg(bRefused)]).toEqual([409, 'FREQUENCY_CHANGE_STRADDLE',
      `${name}'s first weekly run after the change is the one for 9–15 Mar 2026. Calculate that run first: the days after 28 Feb 2026 are judged there.`]);
    const onB = await ack(a, runB, employee);
    expect([onB.statusCode, onB.body.error?.details?.reason]).toEqual([409, 'FREQUENCY_STRADDLE_ACK_REFUSED']);
    const aRefused = await a.api.calculate(runA);
    expect(a.msg(aRefused)).toContain('1–8 Mar 2026 would not be paid');
    expect((await ack(a, runA, employee)).statusCode).toBe(200);
    await paid(a, runA);
    await paid(a, runB);
  }, 240_000);

  it('weekly to fortnightly: the second fortnight waits for the first, whose gap is acknowledged on it', async () => {
    const { employee } = await b.employee(5000);
    expect((await b.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${employee}/pay-frequency`, employee,
      { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
    await paid(b, id(await create(b, { frequency: 'weekly', periodStart: '2026-02-23' })));
    expect(await setEmployeePayFrequency(b.company, employee, 'fortnightly', actor(b), true, '2026-03-02')).toEqual({ payFrequency: 'fortnightly' });
    expect((await b.call(payWeek as Route, 'PUT', '/api/payroll/settings/pay-week', undefined,
      { body: { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: '2026-03-09' } })).statusCode).toBe(200);
    const f1 = id(await create(b, { frequency: 'fortnightly', periodStart: '2026-03-09' }));
    const f2 = id(await create(b, { frequency: 'fortnightly', periodStart: '2026-03-23' }));
    const name = await nameOf(b, employee);
    expect(b.msg(await b.api.calculate(f2))).toBe(`${name}'s first fortnightly run after the change is the one for 9–22 Mar 2026. `
      + 'Calculate that run first: the days after 1 Mar 2026 are judged there.');
    expect(b.msg(await b.api.calculate(f1))).toContain('2–8 Mar 2026 would not be paid');
    expect((await ack(b, f1, employee)).statusCode).toBe(200);
    await paid(b, f1);
    await paid(b, f2);
  }, 240_000);
});
