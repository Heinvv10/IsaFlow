/**
 * Wave 6 FQd, review #1622 round 1 (quality): through the real routes (withAuth, app_user, RLS).
 *  - M1: the three FQd write routes (DELETE runs/[id], PUT pay-week, PUT pay-frequency) refuse a Login-as session
 *    (403 IMPERSONATION_FORBIDDEN) and an agent token (403 AGENT_FORBIDDEN), writing nothing and auditing nothing.
 *  - L1: a weekly create waits for a pay-week change in flight (the lock the pay-week PUT takes) and is judged on the
 *    pay week it then reads: a Monday start refused once the week starts on Tuesday.
 *  - L3: delete and calculate on one draft, each order forced on the approval lock: delete first wins (calculate 404,
 *    no header, no line; it was a 500 before review #1622 L3); calculate first wins (delete 409, header and lines kept).
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { agent, audits, cleanup, loginAs, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import runDetail from '../../pages/api/payroll/runs/[id]';
import payWeek from '../../pages/api/payroll/settings/pay-week';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { dayNumber, isoDow, isoOfDay } from '@/modules/accounting/services/payroll/payrollPayWeek';
import { todaySast } from '@/modules/accounting/services/payroll/payrollPayWeekSettings';

type Opts = { user?: string };
let a: R;
const t = dayNumber(todaySast())!;
/** Mondays five and six weeks out: clear of the other FQd suites' weeks. */
const MON = isoOfDay(t + 35 - (isoDow(t) - 1));

const create = (periodStart: string, o: Opts = {}) =>
  a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { ...o, body: { frequency: 'weekly', periodStart } });
const del = (id: string, o: Opts = {}) => a.call(runDetail as Route, 'DELETE', `/api/payroll/runs/${id}`, id, o);
const putWeek = (body: unknown, o: Opts = {}) => a.call(payWeek as Route, 'PUT', '/api/payroll/settings/pay-week', undefined, { ...o, body });
const putFreq = (id: string, body: unknown, o: Opts = {}) =>
  a.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${id}/pay-frequency`, id, { ...o, body });
const one = async (q: string, p: unknown[]) => (await a.pool.query(q, p)).rows[0];
const reason = (res: { body: { error?: { code?: string; details?: { reason?: string } } } }) =>
  res.body.error?.details?.reason ?? res.body.error?.code;

beforeAll(async () => {
  a = await rig('fqd-review');
  await a.setup();
}, 120_000);
afterAll(async () => { await cleanup(a); });

describe('M1: Login-as and agent sessions are refused by the FQd write routes, writing nothing', () => {
  it('DELETE runs/[id], PUT pay-week and PUT pay-frequency', async () => {
    const imp = await loginAs(a, a.admin);
    const bot = await agent(a, a.admin);
    const run = String((await create(MON)).body.data!.id);
    const { employee } = await a.employee(20000);
    const auditsBefore = [await audits(a, 'payroll_run'), await audits(a, 'payroll_company_settings'), await audits(a, 'payroll_employee')];
    for (const [user, code] of [[imp, 'IMPERSONATION_FORBIDDEN'], [bot, 'AGENT_FORBIDDEN']] as const) {
      const d = await del(run, { user });
      expect([d.statusCode, reason(d)], `delete ${code}`).toEqual([403, code]);
      const w = await putWeek({ payWeekStartDow: 2, payWeekday: 5, fortnightAnchor: null }, { user });
      expect([w.statusCode, reason(w)], `pay week ${code}`).toEqual([403, code]);
      const f = await putFreq(employee, { payFrequency: 'weekly' }, { user });
      expect([f.statusCode, reason(f)], `frequency ${code}`).toEqual([403, code]);
    }
    expect(await one('SELECT status FROM payroll_run_headers WHERE id = $1', [run])).toEqual({ status: 'draft' });
    expect(await one('SELECT count(*)::int AS n FROM payroll_company_settings WHERE company_id = $1', [a.company])).toEqual({ n: 0 });
    expect(await one('SELECT pay_frequency FROM payroll_employees WHERE id = $1', [employee])).toEqual({ pay_frequency: 'monthly' });
    expect([await audits(a, 'payroll_run'), await audits(a, 'payroll_company_settings'), await audits(a, 'payroll_employee')])
      .toEqual(auditsBefore);
    expect((await del(run)).statusCode).toBe(200);
  });
});

describe('L1: a create is judged on the pay week as it is once a change in flight commits', () => {
  it('a Monday start waits for the change to a Tuesday week, then is refused (400), writing no run', async () => {
    // The pay-week PUT in flight, by hand: its lock taken and its write made, not yet committed.
    const client = await a.pool.connect();
    let res: Awaited<ReturnType<typeof create>>;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)", [a.admin]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('payroll_approval:' || $1, 0))", [a.company]);
      await client.query(
        'INSERT INTO payroll_company_settings (company_id, pay_week_start_dow, pay_weekday) VALUES ($1, 2, 5)', [a.company]);
      const pending = create(isoOfDay(dayNumber(MON)! + 7));
      await new Promise((r) => setTimeout(r, 500));
      await client.query('COMMIT');
      res = await pending;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    expect([res.statusCode, res.body.error?.message]).toEqual([400, expect.stringContaining('starts on a Tuesday')]);
    expect(await one('SELECT count(*)::int AS n FROM payroll_run_headers WHERE company_id = $1 AND pay_frequency = $2', [a.company, 'weekly']))
      .toEqual({ n: 0 });
    await a.pool.query('DELETE FROM payroll_company_settings WHERE company_id = $1', [a.company]);
  });
});

describe('L1 lock move: two creates of one period at once are still serialised', () => {
  it('one 201, the other 409 PAY_PERIOD_EXISTS (never a 500 from the unique key), one row', async () => {
    const week = isoOfDay(dayNumber(MON)! + 14);
    for (let i = 0; i < 3; i++) {
      const results = await Promise.all([create(week), create(week)]);
      expect(results.map((r) => r.statusCode).sort(), `round ${i}`).toEqual([201, 409]);
      expect(reason(results.find((r) => r.statusCode === 409)!), `round ${i}`).toBe('PAY_PERIOD_EXISTS');
      const rows = (await a.pool.query('SELECT id FROM payroll_run_headers WHERE company_id = $1 AND period_start = $2', [a.company, week])).rows;
      expect(rows).toHaveLength(1);
      expect((await del(String(rows[0]!.id))).statusCode).toBe(200);
    }
  });
});

describe('L3: delete racing calculate on one draft, each order forced', () => {
  /**
   * Both take the company payroll-approval lock first (the census in the PR body). Held here by hand, the first request
   * queues on it, then the second; on release PostgreSQL grants the waiters in arrival order, so `first` runs to the
   * end before `second` starts.
   */
  async function inOrder<A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
    const client = await a.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('payroll_approval:' || $1, 0))", [a.company]);
      const one = first();
      await new Promise((r) => setTimeout(r, 400));
      const two = second();
      await new Promise((r) => setTimeout(r, 400));
      await client.query('COMMIT');
      return [await one, await two];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  const state = async (run: string) => ({
    header: (await one('SELECT count(*)::int AS n FROM payroll_run_headers WHERE id = $1', [run])).n,
    lines: (await one('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [run])).n,
  });

  it('delete first: the delete wins (200); the calculate finds no run (404); no header, no line', async () => {
    await a.employee(20000);
    const run = String((await a.api.createRun(1)).body.data!.id);
    const [d, c] = await inOrder(() => del(run), () => a.api.calculate(run));
    expect(d.statusCode).toBe(200);
    expect(c.statusCode).toBe(404);
    expect(await state(run)).toEqual({ header: 0, lines: 0 });
  });

  it('calculate first: the calculate wins (200); the delete is refused (409 RUN_NOT_DELETABLE); header and lines kept', async () => {
    const run = String((await a.api.createRun(2)).body.data!.id);
    const [c, d] = await inOrder(() => a.api.calculate(run), () => del(run));
    expect(c.statusCode).toBe(200);
    expect([d.statusCode, reason(d)]).toEqual([409, 'RUN_NOT_DELETABLE']);
    const after = await state(run);
    expect([after.header, after.lines > 0]).toEqual([1, true]);
  });
});
