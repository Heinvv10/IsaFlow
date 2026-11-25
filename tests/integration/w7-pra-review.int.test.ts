/**
 * W29 review #1901 on real rows (breaker repros ported, plus the fixes' own cases):
 *  - H1: a leaver or starter whose salary changes mid-month is measured against their employed window, so the split
 *    rows sum to their full pay (a raise never pays less than none);
 *  - a row starting and ending inside the month: its working days;
 *  - M4 / R2-M2: a row a package cut is paid its share beside the package once-off, and the pair is recorded;
 *  - M7: a row that ended before the employee started is not read (no "0 of 18 days" item);
 *  - M5: the pay-run grid's recurring cell is what the line pays;
 *  - L2: a weekly run apportions by calendar days through the SQL readers, and a split week foots to the whole.
 * July 2026: 23 working days. Leaver to 15 July: 11 (1-9 July: 7, 10-15: 4). Starter from 8 July: 18 (8-19: 8, 20-31: 10).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany } from './w3-01-payroll.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { readAmounts } from '@/modules/accounting/services/payroll/payrollRunPeriodInputsRead';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const co = crypto.randomUUID();
const jul = crypto.randomUUID();
const wk = crypto.randomUUID();
let salary = '';
let allow = '';
const ids: Record<string, string> = {};
const r2 = (n: number) => Math.round(n * 100) / 100;

async function emp(num: string, start: string, end: string | null, rows: Array<[string, number, string, string | null, boolean, boolean?]>, frequency = 'monthly') {
  const id = crypto.randomUUID();
  ids[num] = id;
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,status,medical_aid_main_member,pay_frequency)
     VALUES($1,$2,$3,'B','T',$4::date,$5::date,'active',false,$6)`, [id, co, num, start, end, frequency]);
  for (const [comp, amount, from, to, rec, cut] of rows) {
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred,superseded_at)
       VALUES($1,$2,$3,$4::date,$5::date,$6,FALSE,$7)`, [id, comp === 'sal' ? salary : allow, amount, from, to, rec, cut ? new Date('2026-07-01T10:00:00Z') : null]);
  }
}
const lineOf = async (run: string, num: string) => (await pool.query(
  'SELECT gross_pay::float8 AS g, component_breakdown AS b FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, ids[num]])).rows[0] as
  { g: number; b: Array<{ componentId: string; componentName: string; amount: number; onceOff?: true; share?: { days: number; of: number } }> } | undefined;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-31T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, 'W29 review']);
  await seedPayrollCompany(pool, co, 20000);
  salary = String((await pool.query("SELECT id FROM payroll_components WHERE company_id=$1 AND name='Basic Salary'", [co])).rows[0].id);
  allow = crypto.randomUUID();
  await pool.query(`INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable) VALUES($1,$2,'Allowance','3713','earning',true)`, [allow, co]);
  await emp('L-NORAISE', '2020-01-01', '2026-07-15', [['sal', 10000, '2020-01-01', null, true]]);
  await emp('L-RAISE', '2020-01-01', '2026-07-15', [['sal', 10000, '2020-01-01', '2026-07-09', true], ['sal', 12000, '2026-07-10', null, true]]);
  await emp('ST-NORAISE', '2026-07-08', null, [['sal', 10000, '2026-07-08', null, true]]);
  await emp('ST-RAISE', '2026-07-08', null, [['sal', 10000, '2026-07-08', '2026-07-19', true], ['sal', 12000, '2026-07-20', null, true]]);
  await emp('INSIDE', '2020-01-01', null, [['sal', 10000, '2020-01-01', null, true], ['allow', 2300, '2026-07-13', '2026-07-17', true]]);
  // M4: a package cut the allowance on the 15th and wrote a once-off of it for the rest of the month.
  await emp('PKG-ONCE', '2020-01-01', null, [['sal', 10000, '2020-01-01', null, true], ['allow', 2300, '2020-01-01', '2026-07-15', true, true],
    ['allow', 1200, '2026-07-16', '2026-07-31', false]]);
  // M7: an allowance that ended before the starter's first day.
  await emp('ST-BEFORE', '2026-07-08', null, [['sal', 10000, '2026-07-08', null, true], ['allow', 2300, '2026-07-01', '2026-07-03', true]]);
  // L2 weekly: Saturday 6 - Friday 12 June 2026, a R6 000 week re-dated on Wednesday the 10th.
  await emp('W-SPLIT', '2020-01-01', null, [['sal', 6000, '2020-01-01', '2026-06-09', true], ['sal', 6000, '2026-06-10', null, true]], 'weekly');
  await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,7,2026,'draft')", [jul, co]);
  await calculatePayrollRun(jul, co);
  await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,pay_frequency,period_start,period_end)
    VALUES($1,$2,6,2026,'draft','weekly','2026-06-06','2026-06-12')`, [wk, co]);
  await calculatePayrollRun(wk, co);
});

afterAll(async () => { vi.useRealTimers(); try { await cleanPayrollCompanies(pool, [co]); } finally { await pool.end(); } });

describe('H1: the employed window', () => {
  it('a leaver raised on the 10th: 7/11 + 4/11, never below a leaver with no raise', async () => {
    expect((await lineOf(jul, 'L-NORAISE'))!.g).toBe(10000);
    expect((await lineOf(jul, 'L-RAISE'))!.g).toBe(r2(r2(10000 * 7 / 11) + r2(12000 * 4 / 11)));
  });
  it('a starter raised on the 20th: 8/18 + 10/18, never below a starter with no raise', async () => {
    expect((await lineOf(jul, 'ST-NORAISE'))!.g).toBe(10000);
    expect((await lineOf(jul, 'ST-RAISE'))!.g).toBe(r2(r2(10000 * 8 / 18) + r2(12000 * 10 / 18)));
  });
  it('a row starting and ending inside July: 5 of 23 working days', async () => {
    expect((await lineOf(jul, 'INSIDE'))!.g).toBe(10000 + r2(2300 * 5 / 23));
  });
});

describe('the readers', () => {
  // Review R2-M2 (decision: drop the M4 skip): the cut row's 1-15 July is paid its share (11 of 23 working days), and the
  // package once-off beside it is a share beside a once-off, which approval refuses until acknowledged (w7-pra-share-ack).
  it('M4/R2-M2: a package-cut row is paid its share beside the package once-off, and the pair is recorded', async () => {
    const l = (await lineOf(jul, 'PKG-ONCE'))!;
    expect(l.g).toBe(10000 + r2(2300 * 11 / 23) + 1200);
    expect(l.b.filter((i) => i.share).map((i) => `${i.share!.days}/${i.share!.of}`)).toEqual(['11/23']);
    const codes = (await pool.query('SELECT validation_results v FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [jul, ids['PKG-ONCE']])).rows[0].v
      .map((x: { code: string }) => x.code);
    expect(codes).toContain('RECURRING_SHARE_BESIDE_ONCE_OFF');
  });
  it('M7: a row that ended before the starter started is not read', async () => {
    const l = (await lineOf(jul, 'ST-BEFORE'))!;
    expect(l.g).toBe(10000);
    expect(l.b.map((i) => i.componentName)).toEqual(['Basic Salary']);
  });
  it("M5: the grid's recurring cell is the line's recurring pay", async () => {
    const grid = await readAmounts(co, { year: 2026, month: 7 }, [salary, allow], [ids['L-RAISE']!, ids.INSIDE!]);
    for (const num of ['L-RAISE', 'INSIDE']) {
      const line = (await lineOf(jul, num))!;
      for (const comp of [salary, allow]) {
        const want = r2(line.b.filter((i) => i.componentId === comp && !i.onceOff).reduce((t, i) => t + i.amount, 0));
        const cell = grid.recurring.find((r) => r.employeeId === ids[num] && r.componentId === comp);
        expect(r2(cell?.amount ?? 0), `${num} ${comp}`).toBe(want);
      }
    }
  });
});

describe('L2: weekly through the SQL readers', () => {
  it('a week re-dated on the Wednesday pays 4/7 + 3/7 of R6 000 = R6 000, calendar days', async () => {
    const l = (await lineOf(wk, 'W-SPLIT'))!;
    expect(l.g).toBe(6000);
    expect(l.b.map((i) => i.share && `${i.share.days}/${i.share.of}`).sort()).toEqual(['3/7', '4/7']);
  });
});
