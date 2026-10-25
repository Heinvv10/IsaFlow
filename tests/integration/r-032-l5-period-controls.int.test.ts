/**
 * R-032 re-check: period controls and leave decisions refuse a "Login as"
 * session (Hein, 2026-09-26). Fiscal-period close / lock / REOPEN (single,
 * bulk and close_year), VAT period lock / unlock, and leave approve / reject
 * each answer 403 IMPERSONATION_FORBIDDEN with nothing written. Cancelling a
 * leave request is not a decision and stays allowed; the target's own session
 * is not refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NextApiHandler } from 'next';
import fiscalPeriodsAction from '../../pages/api/accounting/fiscal-periods-action';
import vatPeriodLocks from '../../pages/api/accounting/vat-period-locks';
import leaveRequest from '../../pages/api/payroll/leave/[id]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Call, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'R032 periods');
const period = { open1: crypto.randomUUID(), open2: crypto.randomUUID(), closed: crypto.randomUUID() };
const vatLock = crypto.randomUUID();
const employee = crypto.randomUUID();
const leaveType = crypto.randomUUID();
const leave = crypto.randomUUID();

beforeAll(async () => {
  await fx.setUp();
  const rows: Array<[string, number, string, string, string]> = [
    [period.open1, 7, '2026-07-01', '2026-07-31', 'open'],
    [period.open2, 8, '2026-08-01', '2026-08-31', 'open'],
    [period.closed, 6, '2026-06-01', '2026-06-30', 'closed'],
  ];
  for (const [id, n, start, end, status] of rows) {
    await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
      VALUES($1,$2,$3,$4,2026,$5,$6,$7)`, [id, fx.company, `P${n}`, n, start, end, status]);
  }
  await pool.query(`INSERT INTO vat_period_locks(id,company_id,period_start,period_end,output_tax,input_tax,net_vat,
      posted_through,locked_by) VALUES($1,$2,'2026-03-01','2026-04-30',0,0,0,now(),$3)`, [vatLock, fx.company, fx.target]);
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date, medical_aid_main_member)
    VALUES($1,$2,'R032','Lee','Ave','2026-01-01', true)`, [employee, fx.company]);
  await pool.query('INSERT INTO payroll_leave_types(id,company_id,name) VALUES($1,$2,$3)', [leaveType, fx.company, 'Annual']);
  await pool.query(`INSERT INTO payroll_leave_requests(id,company_id,employee_id,leave_type_id,start_date,end_date,days,status)
    VALUES($1,$2,$3,$4,'2026-10-01','2026-10-02',2,'pending')`, [leave, fx.company, employee, leaveType]);
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_leave_requests WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM payroll_leave_types WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM vat_period_locks WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [fx.company]);
    await fx.tearDown();
  } finally { await pool.end(); }
});

const state = async () => (await pool.query(`SELECT
    (SELECT json_agg(json_build_object('id', id, 'status', status, 'closed_by', closed_by) ORDER BY id)
       FROM fiscal_periods WHERE company_id=$1) AS periods,
    (SELECT json_agg(json_build_object('id', id, 'unlocked_at', unlocked_at) ORDER BY id)
       FROM vat_period_locks WHERE company_id=$1) AS vat_locks,
    (SELECT json_agg(json_build_object('status', status, 'approved_by', approved_by, 'approved_at', approved_at))
       FROM payroll_leave_requests WHERE company_id=$1) AS leave,
    (SELECT count(*) FROM gl_journal_entries WHERE company_id=$1) AS journals,
    (SELECT count(*) FROM audit_log WHERE company_id=$1) AS audits`, [fx.company])).rows[0];

type Case = { name: string; handler: NextApiHandler; call: Call };
const FP = (body: Record<string, unknown>): Call => ({ body });
const CASES: Case[] = [
  { name: 'fiscal period close', handler: fiscalPeriodsAction, call: FP({ action: 'close', id: period.open1 }) },
  { name: 'fiscal period lock', handler: fiscalPeriodsAction, call: FP({ action: 'lock', id: period.closed }) },
  { name: 'fiscal period reopen', handler: fiscalPeriodsAction, call: FP({ action: 'reopen', id: period.closed }) },
  { name: 'fiscal period bulk close', handler: fiscalPeriodsAction,
    call: FP({ action: 'bulk_close', ids: [period.open1, period.open2] }) },
  { name: 'fiscal period bulk lock', handler: fiscalPeriodsAction, call: FP({ action: 'bulk_lock', ids: [period.closed] }) },
  { name: 'fiscal period bulk reopen', handler: fiscalPeriodsAction, call: FP({ action: 'bulk_reopen', ids: [period.closed] }) },
  { name: 'fiscal year close (close_year)', handler: fiscalPeriodsAction, call: FP({ action: 'close_year', fiscalYear: 2026 }) },
  { name: 'VAT period lock', handler: vatPeriodLocks,
    call: FP({ action: 'lock', periodStart: '2026-05-01', periodEnd: '2026-06-30', force: true }) },
  { name: 'VAT period unlock', handler: vatPeriodLocks, call: FP({ action: 'unlock', lockId: vatLock, reason: 'r032' }) },
  { name: 'leave approve', handler: leaveRequest,
    call: { method: 'PUT', query: { id: leave }, body: { status: 'approved' } } },
  { name: 'leave reject', handler: leaveRequest,
    call: { method: 'PUT', query: { id: leave }, body: { status: 'rejected' } } },
];

describe('R-032 — a Login-as session changes no period control and decides no leave', () => {
  let loginAs: Jar;
  beforeAll(async () => { loginAs = await fx.loginAsTarget(); });

  it.each(CASES)('refuses $name with 403 and writes nothing', async ({ handler, call }) => {
    const before = await state();
    const result = await fx.call(handler, loginAs, call);
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
    expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await state()).toEqual(before);
  });

  it('does not refuse cancelling a leave request (not a decision)', async () => {
    const result = await fx.call(leaveRequest, loginAs, { method: 'PUT', query: { id: leave }, body: { status: 'cancelled' } });
    expect(reasonOf(result), JSON.stringify(result.state.body)).not.toBe('IMPERSONATION_FORBIDDEN');
    await pool.query(`UPDATE payroll_leave_requests SET status='pending' WHERE id=$1`, [leave]);
  });

  it.each(CASES)('does not refuse $name on the target\'s own session', async ({ handler, call }) => {
    const result = await fx.call(handler, await fx.ownSession(), call);
    expect(reasonOf(result), JSON.stringify(result.state.body)).not.toBe('IMPERSONATION_FORBIDDEN');
  });
});
