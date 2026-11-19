/**
 * Wave 6 FQd, breaker #1622 M2 (Hein ruling 2026-11-19: REFUSE plus a once-off, no pro-rata). A pay-frequency change at
 * the 2026/27 tax-year start (Sun 1 March 2026), default pay week (Mon-Sun, paid Friday):
 *  A. weekly -> monthly: the week 23 Feb - 1 Mar 2026 (paid Fri 27 Feb: tax year 2026) straddles 1 March. The change is
 *     accepted (the straddling week counts in the old year by its pay date). The March monthly run (1-31 Mar) pays
 *     1 March twice: refused at calculate and in the MCP dry run (409 FREQUENCY_CHANGE_STRADDLE, naming the day and the
 *     once-off), until an owner or admin acknowledges it (Login-as and a manager refused; audited); then it calculates
 *     and approves. With the acknowledgement gone, approval refuses it too.
 *  B. monthly -> weekly: February paid monthly; the first week starting Mon 2 March leaves Sun 1 March unpaid: refused
 *     until acknowledged; the next week, contiguous, is not judged.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { rig, type Route } from './brkr.helpers';
import { audits, cleanup, loginAs, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import straddleRoute from '../../pages/api/payroll/runs/[id]/frequency-change';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { setEmployeePayFrequency } from '@/modules/accounting/services/payroll/payrollEmployeePayFrequency';

type Opts = { user?: string };
let a: R;
let b: R;
const create = (r: R, body: unknown) => r.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body });
const putFreq = (r: R, id: string, f: string) =>
  r.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${id}/pay-frequency`, id, { body: { payFrequency: f } });
const straddles = (r: R, run: string) => r.call(straddleRoute as Route, 'GET', `/api/payroll/runs/${run}/frequency-change`, run);
const ack = (r: R, run: string, employeeId: string, o: Opts = {}) =>
  r.call(straddleRoute as Route, 'POST', `/api/payroll/runs/${run}/frequency-change`, run, { ...o, body: { employeeId } });
const lines = async (r: R, run: string) => Number((await r.pool.query('SELECT count(*) FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!.count);

async function paid(r: R, run: string): Promise<void> {
  const c = await r.api.calculate(run);
  if (c.statusCode !== 200) throw new Error(`calculate: ${r.msg(c)}`);
  const ap = await r.api.approve(run);
  if (ap.statusCode !== 200) throw new Error(`approve: ${r.msg(ap)}`);
}
const id = (res: { body: { data?: { id?: unknown } } }) => String(res.body.data!.id);

async function dryRun(r: R, runId: string) {
  const ctx = { userId: r.admin, companyId: r.company, scopes: ['read:payroll', 'write:payroll'], tokenJti: null, oauthAppId: null, companyRole: 'admin' };
  const res = await withAlsTransaction({ userId: ctx.userId, companyId: ctx.companyId },
    () => mcpRegistry.call('calculate_pay_run', { idempotency_key: `fqd-${crypto.randomUUID()}`, run_id: runId, dry_run: true }, ctx as never)) as
    { isError?: boolean; content: Array<{ text: string }> };
  return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
}

beforeAll(async () => {
  a = await rig('fqd-straddle-a');
  b = await rig('fqd-straddle-b');
  await a.setup();
  await b.setup();
}, 120_000);
afterAll(async () => {
  await cleanup(a);
  await cleanup(b);
});

describe('A. weekly -> monthly across the week that straddles 1 March 2026', () => {
  let employee = '';
  let march = '';
  it('the change is accepted; the March run is refused at calculate and in the dry run, naming 1 March and the once-off', async () => {
    ({ employee } = await a.employee(5000));
    expect((await putFreq(a, employee, 'weekly')).statusCode).toBe(200);
    await paid(a, id(await create(a, { frequency: 'weekly', periodStart: '2026-02-16' })));
    await paid(a, id(await create(a, { frequency: 'weekly', periodStart: '2026-02-23' })));
    // On the day it takes effect, 1 March 2026: the straddling week is final and counts in the old year by its pay date.
    const actor = { userId: a.admin, userEmail: `${a.admin}@test.local`, ip: undefined, userAgent: undefined, sessionId: null };
    expect(await setEmployeePayFrequency(a.company, employee, 'monthly', actor, true, '2026-03-01')).toEqual({ payFrequency: 'monthly' });
    march = id(await create(a, { month: 3, year: 2026 }));
    const refused = await a.api.calculate(march);
    expect([refused.statusCode, refused.body.error?.details?.code]).toEqual([409, 'FREQUENCY_CHANGE_STRADDLE']);
    const name = (await a.pool.query("SELECT first_name || ' ' || last_name AS n FROM payroll_employees WHERE id = $1", [employee])).rows[0]!.n;
    const says = `${name} was last paid weekly up to 1 Mar 2026, and this monthly run starts on 1 Mar 2026: 1 Mar 2026 would be paid `
      + 'twice. Settle that day with a once-off adjustment, then acknowledge the change on this run (an owner or admin).';
    expect(refused.body.error?.message).toBe(says);
    expect(await lines(a, march)).toBe(0);
    const dry = await dryRun(a, march);
    expect([dry.isError, dry.text]).toEqual([true, expect.stringContaining('1 Mar 2026 would be paid twice')]);
    const listed = await straddles(a, march);
    expect(listed.body.data).toMatchObject({ straddles: [{ employeeId: employee, oldFrequency: 'weekly', oldEnd: '2026-03-01',
      start: '2026-03-01', overlap: { from: '2026-03-01', to: '2026-03-01' }, gap: null, acknowledged: false, message: says }] });
  }, 240_000);

  it('only an owner or admin in their own session acknowledges it (audited once); then it calculates and approves', async () => {
    const before = await audits(a, 'payroll_run_frequency_change');
    const imp = await ack(a, march, employee, { user: await loginAs(a, a.admin) });
    expect(imp.statusCode).toBe(403);
    expect((await ack(a, march, employee, { user: await a.addUser('manager') })).statusCode).toBe(403);
    expect(await audits(a, 'payroll_run_frequency_change')).toBe(before);
    const done = await ack(a, march, employee);
    expect([done.statusCode, done.body.data?.acknowledged]).toEqual([200, true]);
    expect(await audits(a, 'payroll_run_frequency_change')).toBe(before + 1);
    const again = await ack(a, march, employee);
    expect([again.statusCode, again.body.error?.details?.reason]).toEqual([409, 'FREQUENCY_STRADDLE_ACK_REFUSED']);
    // Exactly the acknowledged day passes (breaker #1622 M-C): a weekly run not yet final paying 9-15 Mar still refuses.
    const stray = String((await a.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, pay_frequency, run_kind, period_start, period_end, run_date)
       VALUES ($1, 3, 2026, 'draft', 'weekly', 'regular', '2026-03-09', '2026-03-15', '2026-03-13') RETURNING id`, [a.company])).rows[0]!.id);
    await a.pool.query('INSERT INTO payroll_run_lines (run_id, employee_id) VALUES ($1, $2)', [stray, employee]);
    const outside = await a.api.calculate(march);
    expect([outside.statusCode, outside.body.error?.details?.code]).toEqual([409, 'PAY_PERIOD_OVERLAP']);
    expect(a.msg(outside)).toContain('is already paid for 9–15 Mar 2026 on a weekly run');
    await a.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [stray]);
    await a.pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [stray]);
    await paid(a, march);
    expect(await lines(a, march)).toBe(1);
  }, 240_000);

  it('approval refuses the run once its acknowledgement no longer holds (frequency_change_straddle)', async () => {
    await a.api.reopen(march);
    expect((await a.api.calculate(march)).statusCode).toBe(200);
    await a.pool.query("DELETE FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_run_frequency_change'", [a.company]);
    const ap = await a.api.approve(march);
    expect(ap.statusCode).not.toBe(200);
    expect(a.msg(ap)).toContain('1 Mar 2026 would be paid twice');
  }, 240_000);
});

describe('B. monthly -> weekly: February monthly, the first week starting Monday 2 March', () => {
  it('leaves 1 March unpaid: refused until acknowledged; the next week, contiguous, is not judged', async () => {
    const { employee } = await b.employee(20000);
    await paid(b, id(await create(b, { month: 2, year: 2026 })));
    expect((await putFreq(b, employee, 'weekly')).statusCode).toBe(200);
    const week = id(await create(b, { frequency: 'weekly', periodStart: '2026-03-02' }));
    const refused = await b.api.calculate(week);
    expect([refused.statusCode, refused.body.error?.details?.code]).toEqual([409, 'FREQUENCY_CHANGE_STRADDLE']);
    expect(refused.body.error?.message).toContain('and this weekly run starts on 2 Mar 2026: 1 Mar 2026 would not be paid. Settle that day with a once-off adjustment');
    expect(await lines(b, week)).toBe(0);
    expect((await ack(b, week, employee)).statusCode).toBe(200);
    await paid(b, week);
    const next = id(await create(b, { frequency: 'weekly', periodStart: '2026-03-09' }));
    expect((await straddles(b, next)).body.data).toEqual({ straddles: [] });
    await paid(b, next);
  }, 240_000);
});
