/**
 * Wave 6 FQd: weekly and fortnightly runs through the real routes (withAuth, app_user, RLS) on two tenants. Claims:
 *  - the pay week: defaults with no row; only an owner or admin sets it; refused input writes nothing; each change is
 *    audited; a final weekly run paid this tax year fixes the start day and pay day (409 PAY_WEEK_LOCKED, nothing
 *    written) but a first fortnight start may still be set; a final fortnightly run fixes the fortnight start;
 *  - a run per period: the period must start on the pay-week day (400, no row); the row carries the period dates, the
 *    pay date as run_date and the pay date's month; the same period again and an overlapping one are 409 with no row;
 *    a fortnight needs the fortnight start (400);
 *  - the employee's frequency: only an owner or admin changes it; a loan refuses weekly (400); a final line this tax
 *    year refuses any change (409); another tenant's employee is 404; every refusal leaves the row and the audit as
 *    they were;
 *  - tenant B sees none of A's settings or runs.
 * Dates are relative to today in Johannesburg (next week), so the "this tax year" lock holds whenever it runs.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { audits, cleanup, type R } from './pe-payslip-email.helpers';
import payWeek from '../../pages/api/payroll/settings/pay-week';
import runs from '../../pages/api/payroll/runs';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { dayNumber, isoDow, isoOfDay, resolveRunPeriod, DEFAULT_PAY_WEEK } from '@/modules/accounting/services/payroll/payrollPayWeek';
import { todaySast } from '@/modules/accounting/services/payroll/payrollPayWeekSettings';

type Opts = { user?: string; company?: string };
let a: R;
let b: R;
const t = dayNumber(todaySast())!;
/** Monday of next week, and the Monday after. */
const MON = isoOfDay(t + 7 - (isoDow(t) - 1));
const MON2 = isoOfDay(dayNumber(MON)! + 7);
const WED = isoOfDay(dayNumber(MON)! + 2);

const getWeek = (r: R, o: Opts = {}) => r.call(payWeek as Route, 'GET', '/api/payroll/settings/pay-week', undefined, o);
const putWeek = (r: R, body: unknown, o: Opts = {}) => r.call(payWeek as Route, 'PUT', '/api/payroll/settings/pay-week', undefined, { ...o, body });
const create = (r: R, body: unknown, o: Opts = {}) => r.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { ...o, body });
const putFreq = (r: R, id: string, body: unknown, o: Opts = {}) =>
  r.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${id}/pay-frequency`, id, { ...o, body });
const runCount = async (r: R) => Number((await r.pool.query('SELECT count(*) FROM payroll_run_headers WHERE company_id = $1', [r.company])).rows[0]!.count);
const settingsRow = async (r: R) => (await r.pool.query(
  'SELECT pay_week_start_dow, pay_weekday, fortnight_anchor::text AS anchor FROM payroll_company_settings WHERE company_id = $1', [r.company])).rows[0];
const freqOf = async (r: R, id: string) => (await r.pool.query('SELECT pay_frequency FROM payroll_employees WHERE id = $1', [id])).rows[0]!.pay_frequency;
const makeFinal = (r: R, id: string) => r.pool.query(
  "UPDATE payroll_run_headers SET status = 'approved', approved_at = now() WHERE id = $1", [id]);

beforeAll(async () => {
  a = await rig('fqd-freq-a');
  b = await rig('fqd-freq-b');
  await a.setup();
  await b.setup();
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) {
    await r.pool.query('DELETE FROM payroll_loans WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM tax_directives WHERE company_id = $1', [r.company]);
    await cleanup(r);
  }
});

describe('the pay week', () => {
  it('reads the defaults with no row; a manager may read but not set; refused input writes nothing', async () => {
    expect((await getWeek(a)).body.data).toEqual({ payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: null, locked: { week: false, anchor: false } });
    const manager = await a.addUser('manager');
    expect((await getWeek(a, { user: manager })).statusCode).toBe(200);
    expect((await putWeek(a, { payWeekStartDow: 2, payWeekday: 5, fortnightAnchor: null }, { user: manager })).statusCode).toBe(403);
    for (const bad of [
      { payWeekStartDow: 0, payWeekday: 5, fortnightAnchor: null },
      { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: WED },
      { payWeekStartDow: 1, payWeekday: 5 },
      { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: null, extra: 1 },
    ]) expect((await putWeek(a, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect(await settingsRow(a)).toBeUndefined();
    expect(await audits(a, 'payroll_company_settings')).toBe(0);
  });

  it('an owner or admin sets it, audited once per change; tenant B keeps its defaults', async () => {
    const res = await putWeek(a, { payWeekStartDow: 1, payWeekday: 4, fortnightAnchor: null });
    expect([res.statusCode, res.body.data?.payWeekday]).toEqual([200, 4]);
    await putWeek(a, { payWeekStartDow: 1, payWeekday: 4, fortnightAnchor: null });
    expect(await audits(a, 'payroll_company_settings')).toBe(1);
    expect((await getWeek(b)).body.data?.payWeekday).toBe(5);
    await putWeek(a, { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: null });
  });
});

describe('a weekly run per period', () => {
  let weekly = '';
  it('refuses a start off the pay-week day, writing no run', async () => {
    const res = await create(a, { frequency: 'weekly', periodStart: WED });
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('starts on a Monday');
    expect((await create(a, { frequency: 'weekly', periodStart: MON, month: 1 })).statusCode).toBe(400);
    expect((await create(a, { frequency: 'yearly', periodStart: MON })).statusCode).toBe(400);
    expect(await runCount(a)).toBe(0);
  });

  it('stores the period, the pay date as run_date and the pay date\'s month', async () => {
    const res = await create(a, { frequency: 'weekly', periodStart: MON });
    expect(res.statusCode).toBe(201);
    weekly = String(res.body.data!.id);
    const want = resolveRunPeriod('weekly', MON, DEFAULT_PAY_WEEK);
    const row = (await a.pool.query(
      `SELECT pay_frequency, run_kind, status, period_start::text, period_end::text, run_date::date::text AS run_date, period_year, period_month
         FROM payroll_run_headers WHERE id = $1`, [weekly])).rows[0];
    expect(row).toEqual({
      pay_frequency: 'weekly', run_kind: 'regular', status: 'draft', period_start: want.periodStart, period_end: want.periodEnd,
      run_date: want.payDate, period_year: want.periodYear, period_month: want.periodMonth,
    });
    expect(res.body.data).toMatchObject({ payFrequency: 'weekly', periodStart: MON, periodEnd: want.periodEnd });
  });

  it('refuses the same period again and an overlapping one (pay week changed), writing no run', async () => {
    const dup = await create(a, { frequency: 'weekly', periodStart: MON });
    expect([dup.statusCode, dup.body.error?.details?.reason]).toEqual([409, 'PAY_PERIOD_EXISTS']);
    expect((await putWeek(a, { payWeekStartDow: 3, payWeekday: 1, fortnightAnchor: null })).statusCode).toBe(200);
    const over = await create(a, { frequency: 'weekly', periodStart: WED });
    expect([over.statusCode, over.body.error?.details?.reason]).toEqual([409, 'PAY_PERIOD_OVERLAP']);
    expect(await runCount(a)).toBe(1);
    expect((await putWeek(a, { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: null })).statusCode).toBe(200);
  });

  it('a final weekly run fixes the start and pay day (409, nothing written); a first fortnight start may still be set', async () => {
    await makeFinal(a, weekly);
    const before = await audits(a, 'payroll_company_settings');
    const res = await putWeek(a, { payWeekStartDow: 2, payWeekday: 5, fortnightAnchor: null });
    expect([res.statusCode, res.body.error?.details?.reason]).toEqual([409, 'PAY_WEEK_LOCKED']);
    expect(await settingsRow(a)).toMatchObject({ pay_week_start_dow: 1, pay_weekday: 5, anchor: null });
    expect(await audits(a, 'payroll_company_settings')).toBe(before);
    expect((await getWeek(a)).body.data?.locked).toEqual({ week: true, anchor: false });
    const anchor = await putWeek(a, { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: MON });
    expect([anchor.statusCode, anchor.body.data?.fortnightAnchor]).toEqual([200, MON]);
  });
});

describe('a fortnightly run', () => {
  it('needs the fortnight start, then is fixed by a final fortnightly run', async () => {
    const off = await create(a, { frequency: 'fortnightly', periodStart: MON2 });
    expect([off.statusCode, off.body.error?.message]).toEqual([400, expect.stringContaining('A fortnight starts every 14 days')]);
    expect((await create(b, { frequency: 'fortnightly', periodStart: MON })).body.error?.message)
      .toBe('Set the fortnight start in the pay week settings before the first fortnightly run.');
    const made = await create(a, { frequency: 'fortnightly', periodStart: MON });
    expect(made.statusCode).toBe(201);
    expect(made.body.data).toMatchObject({ payFrequency: 'fortnightly', periodEnd: isoOfDay(dayNumber(MON)! + 13) });
    await makeFinal(a, String(made.body.data!.id));
    const res = await putWeek(a, { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: MON2 });
    expect([res.statusCode, res.body.error?.details?.reason]).toEqual([409, 'PAY_WEEK_LOCKED']);
    expect((await settingsRow(a))!.anchor).toBe(MON);
  });

  it('tenant B sees none of A\'s runs and keeps its own settings', async () => {
    expect(await runCount(b)).toBe(0);
    const list = await b.call(runs as Route, 'GET', '/api/payroll/runs', undefined);
    expect(list.body.data).toEqual([]);
    expect((await getWeek(b)).body.data).toMatchObject({ fortnightAnchor: null, locked: { week: false, anchor: false } });
  });
});

describe('the employee\'s pay frequency', () => {
  it('only an owner or admin changes it, audited; refusals write nothing', async () => {
    const { employee } = await a.employee(20000);
    const manager = await a.addUser('manager');
    const audited = await audits(a, 'payroll_employee');
    expect((await putFreq(a, employee, { payFrequency: 'weekly' }, { user: manager })).statusCode).toBe(403);
    expect((await putFreq(a, employee, { payFrequency: 'daily' })).statusCode).toBe(400);
    expect((await putFreq(a, employee, { payFrequency: 'weekly', x: 1 })).statusCode).toBe(400);
    expect(await freqOf(a, employee)).toBe('monthly');
    expect(await audits(a, 'payroll_employee')).toBe(audited);
    const ok = await putFreq(a, employee, { payFrequency: 'weekly' });
    expect([ok.statusCode, ok.body.data]).toEqual([200, { payFrequency: 'weekly' }]);
    expect(await audits(a, 'payroll_employee')).toBe(audited + 1);
    // The value on file is no change, even from a manager.
    expect((await putFreq(a, employee, { payFrequency: 'weekly' }, { user: manager })).statusCode).toBe(200);
    expect(await audits(a, 'payroll_employee')).toBe(audited + 1);
  });

  it('a loan or a regular-pay directive refuses weekly pay, naming it (§0a.11)', async () => {
    const { employee } = await a.employee(20000);
    await a.pool.query(
      `INSERT INTO payroll_loans (company_id, employee_id, loan_number, description, principal, outstanding_balance, term_months,
         method, start_date, first_deduction_period_year, first_deduction_period_month)
       VALUES ($1, $2, 'L-1', 'Loan', 1000, 1000, 10, 'interest_free', '2026-01-01', 2026, 1)`, [a.company, employee]);
    const res = await putFreq(a, employee, { payFrequency: 'fortnightly' });
    expect([res.statusCode, res.body.error?.details?.reason]).toEqual([400, 'FREQUENCY_UNSUPPORTED_FOR_EMPLOYEE']);
    expect(res.body.error?.message).toContain('an active loan');
    expect(await freqOf(a, employee)).toBe('monthly');
    const { employee: directed } = await a.employee(20000);
    await a.pool.query(
      `INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, amount, tax_rate, effective_date, status)
       VALUES ($1, $2, 'Brk', 'fixed_percentage', 0, 0.25, '2026-01-01', 'approved')`, [a.company, directed]);
    expect((await putFreq(a, directed, { payFrequency: 'weekly' })).body.error?.message).toContain('a regular-pay tax directive');
    expect(await freqOf(a, directed)).toBe('monthly');
  });

  it('a final line this tax year refuses any change (409); another tenant\'s employee is 404', async () => {
    const { employee } = await a.employee(20000);
    const run = (await a.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, approved_at, pay_frequency, run_kind,
         period_start, period_end, run_date)
       VALUES ($1, 1, 2020, 'approved', now(), 'weekly', 'regular', $2::date, $2::date + 6, $2::date + 4) RETURNING id`,
      [a.company, MON2])).rows[0]!.id;
    await a.pool.query('INSERT INTO payroll_run_lines (run_id, employee_id) VALUES ($1, $2)', [run, employee]);
    const res = await putFreq(a, employee, { payFrequency: 'weekly' });
    expect([res.statusCode, res.body.error?.details?.reason]).toEqual([409, 'FREQUENCY_CHANGE_MID_YEAR']);
    expect(await freqOf(a, employee)).toBe('monthly');
    const { employee: theirs } = await b.employee(20000);
    expect((await putFreq(a, theirs, { payFrequency: 'weekly' })).statusCode).toBe(404);
    expect(await freqOf(b, theirs)).toBe('monthly');
  });
});
