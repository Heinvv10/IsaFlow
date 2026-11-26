/**
 * W29 review #1901 round 2 on real rows (breaker round-2 repros ported, plus the fixes' DB cases):
 *  - H1 re-checked: a starter-and-leaver in one month re-dated at one amount, and three rows at one amount, pay R10 000;
 *  - R2-M1 REVERTED (option B, coordinator ruling on #1901, 2026-11-26; ruling 19; Hein 2026-11-02): a monthly leaver whose own
 *    row ends ON their end date (the 15th, before the 27th) is not paid that row and not flagged, as on master (the part
 *    month is entered by hand); one whose row is open is paid in full;
 *  - R2-M2: a package-cut row is paid its share, and the package once-off beside it is a pair approval refuses until acked;
 *  - REPRO 5: a share beside a hand once-off of another component is refused, an acknowledgement clears it, and a changed
 *    amount refuses again (the stale-run gap, a once-off added after acknowledgement without recalculating, is logged for
 *    wave 8: not asserted here);
 *  - R2-H1 / R2-L6: the paid-run guard on real rows: a v21 approved July refuses ending a salary row on the 20th, allows
 *    ending it on 31 July;
 *  - R2-L6: a weekly run apportions a row starting mid-week (calendar days), and the grid's weekly cell is the line's.
 * July 2026: 23 working days; leaver to 15 July: 11; starter-and-leaver 8-24 July: 13.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany } from './w3-01-payroll.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';
import { acknowledgeRecurringShare } from '@/modules/accounting/services/payroll/payrollRecurringShareAck';
import { changeAssignmentDates } from '@/modules/accounting/services/payroll/payrollComponentDateEdit';
import { EmployeeComponentRefused } from '@/modules/accounting/services/payroll/payrollEmployeeComponentRefused';
import { readAmounts } from '@/modules/accounting/services/payroll/payrollRunPeriodInputsRead';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const co = crypto.randomUUID();
const jul = crypto.randomUUID();
const wk = crypto.randomUUID();
const user = crypto.randomUUID();
let salary = '';
let allow = '';
let prorata = '';
const ids: Record<string, string> = {};
const rows: Record<string, string> = {};
const r2 = (n: number) => Math.round(n * 100) / 100;
const C: Record<string, () => string> = { sal: () => salary, allow: () => allow, prorata: () => prorata };
const actor = () => ({ userId: user, userEmail: `${user}@test.local`, ip: '127.0.0.1', userAgent: 'w7-pra-review2', sessionId: null });

async function emp(num: string, start: string, end: string | null, list: Array<[string, number, string, string | null, boolean, boolean?]>, frequency = 'monthly') {
  const id = crypto.randomUUID();
  ids[num] = id;
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,status,medical_aid_main_member,pay_frequency)
     VALUES($1,$2,$3,'B','T',$4::date,$5::date,'active',false,$6)`, [id, co, num, start, end, frequency]);
  for (const [k, [comp, amount, from, to, rec, cut]] of list.entries()) {
    rows[`${num}#${k}`] = (await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred,superseded_at)
       VALUES($1,$2,$3,$4::date,$5::date,$6,FALSE,$7) RETURNING id`, [id, C[comp]!(), amount, from, to, rec, cut ? new Date('2026-07-01T10:00:00Z') : null])).rows[0].id;
  }
}
const lineOf = async (run: string, num: string) => (await pool.query(
  'SELECT gross_pay::float8 AS g, component_breakdown AS b, validation_results AS v FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, ids[num]])).rows[0] as
  { g: number; b: Array<{ componentId: string; amount: number; onceOff?: true; share?: { days: number; of: number } }>; v: Array<{ code: string }> };
const codes = (l: { v: Array<{ code: string }> }) => l.v.map((x) => x.code);
const blocker = async () => (await judgePayrollApproval(co, jul))?.blocker ?? null;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-31T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, 'W29 review round 2']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  // R30 000 (was R20 000): with L-ON-END unpaid under option B the month must stay SDL-liable once June's weekly run is
  // costed after July (the trailing estimate averages both months), so REPRO 5's first blocker is still the share's.
  await seedPayrollCompany(pool, co, 30000);
  await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level) VALUES ($1,'2175','Other deductions','liability','credit',1)`, [co]);
  salary = String((await pool.query("SELECT id FROM payroll_components WHERE company_id=$1 AND name='Basic Salary'", [co])).rows[0].id);
  allow = crypto.randomUUID();
  prorata = crypto.randomUUID();
  await pool.query(`INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable) VALUES($1,$2,'Allowance','3713','earning',true)`, [allow, co]);
  await pool.query(`INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable) VALUES($1,$2,'Allowance pro-rata','3713','earning',true)`, [prorata, co]);
  await emp('STL', '2026-07-08', '2026-07-24', [['sal', 10000, '2026-07-08', '2026-07-14', true], ['sal', 10000, '2026-07-15', null, true]]);
  await emp('THREE', '2020-01-01', null, [['sal', 10000, '2020-01-01', '2026-07-09', true], ['sal', 10000, '2026-07-10', '2026-07-21', true], ['sal', 10000, '2026-07-22', null, true]]);
  await emp('L-ON-END', '2020-01-01', '2026-07-15', [['sal', 10000, '2020-01-01', '2026-07-15', true]]);
  await emp('L-OPEN', '2020-01-01', '2026-07-15', [['sal', 10000, '2020-01-01', null, true]]);
  await emp('ACK', '2020-01-01', null, [['sal', 10000, '2020-01-01', null, true], ['allow', 2300, '2020-01-01', '2026-07-10', true], ['prorata', 800, '2026-07-01', '2026-07-31', false]]);
  await emp('PKG', '2020-01-01', null, [['sal', 10000, '2020-01-01', null, true], ['allow', 2300, '2020-01-01', '2026-07-15', true, true], ['allow', 500, '2026-07-16', '2026-07-31', false]]);
  await emp('W-START', '2020-01-01', null, [['sal', 6000, '2020-01-01', null, true], ['allow', 700, '2026-06-09', null, true]], 'weekly');
  await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,7,2026,'draft')", [jul, co]);
  await calculatePayrollRun(jul, co);
  await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,pay_frequency,period_start,period_end)
    VALUES($1,$2,6,2026,'draft','weekly','2026-06-06','2026-06-12')`, [wk, co]);
  await calculatePayrollRun(wk, co);
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [co]);
    await cleanPayrollCompanies(pool, [co]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('the employed window and the leaver rule', () => {
  it('a starter and leaver in one month (8-24 July), re-dated at one amount: R10 000', async () => {
    expect((await lineOf(jul, 'STL')).g).toBe(10000);
  });
  it('three rows at one amount tile July: R10 000 to the cent (R2-L1)', async () => {
    expect((await lineOf(jul, 'THREE')).g).toBe(10000);
  });
  it("option B: a monthly leaver's own row ending ON their end date (the 15th) is not paid and not flagged; an open row pays in full", async () => {
    expect((await lineOf(jul, 'L-OPEN')).g).toBe(10000);
    const l = await lineOf(jul, 'L-ON-END');
    expect(l.g).toBe(0);
    expect(l.b.filter((i) => i.share)).toEqual([]);
    expect(codes(l)).not.toContain('RECURRING_NEEDS_PRO_RATA');
  });
  it('R2-M2: a package-cut row is paid its share (11 of 23) beside the package once-off, and the pair is recorded', async () => {
    const l = await lineOf(jul, 'PKG');
    expect(l.g).toBe(10000 + r2(2300 * 11 / 23) + 500);
    expect(codes(l)).toContain('RECURRING_SHARE_BESIDE_ONCE_OFF');
  });
});

describe('REPRO 5: a share beside a hand once-off of another component', () => {
  it('is refused, an acknowledgement clears it, and a changed amount after recalculation refuses again', async () => {
    expect(codes(await lineOf(jul, 'ACK'))).toContain('RECURRING_SHARE_BESIDE_ONCE_OFF');
    expect((await blocker())?.detail).toContain('ACK');
    for (const n of ['ACK', 'PKG']) await acknowledgeRecurringShare(co, jul, ids[n]!, actor());
    expect((await blocker())?.code ?? null).not.toBe('recurring_share_beside_once_off');
    await pool.query('UPDATE payroll_employee_components SET amount = 900 WHERE id = $1', [rows['ACK#2']]);
    await calculatePayrollRun(jul, co);
    const b = await blocker();
    expect(b?.code).toBe('recurring_share_beside_once_off');
    expect(b!.detail).toContain('ACK');
    expect(b!.detail).not.toContain('PKG');
  });
});

describe('R2-H1 / R2-L6: the paid-run guard on real rows (a v21 approved July)', () => {
  beforeAll(async () => {
    await pool.query("UPDATE payroll_run_headers SET status='approved', approved_at=clock_timestamp(), calculation_version=21 WHERE id=$1", [jul]);
  });
  const refusedWith = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof EmployeeComponentRefused ? e.message : (() => { throw e; })()));
  it("ending ACK's open salary on 20 July is refused (it changes what July paid); nothing is written", async () => {
    const msg = await refusedWith(changeAssignmentDates(co, rows['ACK#0']!, { kind: 'end', to: '2026-07-20' }, { userId: user, channel: 'rest' }));
    expect(msg).toMatch(/2026-07/);
    expect((await pool.query('SELECT effective_to FROM payroll_employee_components WHERE id=$1', [rows['ACK#0']])).rows[0].effective_to).toBeNull();
  });
  it("a leaver's open salary ended on the 20th, after their last day, is refused too: July read it, it would no longer", async () => {
    expect(await refusedWith(changeAssignmentDates(co, rows['L-OPEN#0']!, { kind: 'end', to: '2026-07-20' }, { userId: user, channel: 'rest' }))).toMatch(/2026-07/);
  });
  it("ending THREE's open salary row on 31 July (the paid month's last day) is allowed: July's share is unchanged", async () => {
    expect(await refusedWith(changeAssignmentDates(co, rows['THREE#2']!, { kind: 'end', to: '2026-07-31' }, { userId: user, channel: 'rest' }))).toBeNull();
    const to = (await pool.query("SELECT to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE id=$1", [rows['THREE#2']])).rows[0].t;
    expect(to).toBe('2026-07-31');
  });
});

describe('R2-L6: weekly through the SQL readers', () => {
  it('an allowance from Tuesday 9 June in the week of 6-12 June pays 4 of 7 calendar days; the grid shows the line', async () => {
    const l = await lineOf(wk, 'W-START');
    expect(l.g).toBe(6000 + r2(700 * 4 / 7));
    const grid = await readAmounts(co, { year: 2026, month: 6, start: '2026-06-06', end: '2026-06-12' }, [allow], [ids['W-START']!]);
    expect(grid.recurring.find((r) => r.componentId === allow)?.amount).toBe(r2(700 * 4 / 7));
  });
});
