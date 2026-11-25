/**
 * W29 review #1901 round 3 on real rows: the two leaver readers (the last-day reader in the band, the ended-rows reader
 * on any day) decide a leaver's own row by ONE successor predicate (payrollLeaverSuccessor), and the pro-rata guard agrees
 * with the pay. Each successor shape is set up twice, the leaver leaving on the 28th (band: the last-day reader) and on
 * the 15th (the ended-rows reader); the pay and the guard's flags are the same for both:
 *  - NEXT: a recurring row of the same component from the next day: the leaver row is replaced (not paid); the successor
 *    starts after the last day, so it is not paid either (coordinator decision): both flagged, approval refused;
 *  - PKG: a package cut the row (superseded_at) and wrote a once-off from the next day: the once-off is paid; the cut row
 *    is flagged as ending (a pay package replaced it), as the band always did;
 *  - PRE953: both rows pre-953 (supersede_inferred) with a once-off from the next day: the old neighbour rule, as PKG;
 *  - GAP: a recurring row from two days later: the leaver row is paid whole (ruling 19); the later row is not paid, flagged.
 * Breaker round 3 REPRO 8 (a package-cut leaver row is not paid a full month on top of its once-off) and REPRO 9 (a
 * leaver row and a later recurring row are not both paid) are these shapes. Plus R3-L3: a weekly leaver whose own row ends
 * on their end date is paid whole and not flagged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany } from './w3-01-payroll.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const co = crypto.randomUUID();
const jul = crypto.randomUUID();
const wk = crypto.randomUUID();
let salary = '';
const ids: Record<string, string> = {};
type Row = { amount: number; from: string; to: string | null; recurring: boolean; cut?: boolean; inferred?: boolean };
const next = (iso: string, n = 1) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function emp(num: string, end: string, rows: Row[], frequency = 'monthly') {
  const id = crypto.randomUUID();
  ids[num] = id;
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,status,medical_aid_main_member,pay_frequency)
     VALUES($1,$2,$3,'L','S','2020-01-01',$4::date,'active',false,$5)`, [id, co, num, end, frequency]);
  for (const r of rows) {
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred,superseded_at)
       VALUES($1,$2,$3,$4::date,$5::date,$6,$7,$8)`,
      [id, salary, r.amount, r.from, r.to, r.recurring, r.inferred === true, r.cut ? new Date('2026-07-01T10:00:00Z') : null]);
  }
}
const SHAPES: Record<string, (end: string) => Row[]> = {
  NEXT: (e) => [{ amount: 10000, from: '2020-01-01', to: e, recurring: true }, { amount: 12000, from: next(e), to: null, recurring: true }],
  PKG: (e) => [{ amount: 10000, from: '2020-01-01', to: e, recurring: true, cut: true }, { amount: 3000, from: next(e), to: '2026-07-31', recurring: false }],
  PRE953: (e) => [{ amount: 10000, from: '2020-01-01', to: e, recurring: true, inferred: true }, { amount: 3000, from: next(e), to: '2026-07-31', recurring: false, inferred: true }],
  GAP: (e) => [{ amount: 10000, from: '2020-01-01', to: e, recurring: true }, { amount: 12000, from: next(e, 2), to: null, recurring: true }],
};
const WANT: Record<string, { gross: number; flags: string[] }> = {
  NEXT: { gross: 0, flags: ['after_end', 'ends'] },
  PKG: { gross: 3000, flags: ['ends'] },
  PRE953: { gross: 3000, flags: ['ends'] },
  GAP: { gross: 10000, flags: ['after_end'] },
};
const ENDS = { band: '2026-07-28', mid: '2026-07-15' } as const;

async function lineOf(run: string, num: string) {
  const r = (await pool.query('SELECT gross_pay::float8 AS g, validation_results AS v FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, ids[num]])).rows[0] as
    { g: number; v: Array<{ code: string; message: string }> };
  const flags = r.v.filter((x) => x.code === 'RECURRING_NEEDS_PRO_RATA')
    .map((x) => (x.message.includes('starts after the employee left') ? 'after_end' : x.message.includes('is not paid at all') ? 'ends' : 'other')).sort();
  return { gross: r.g, flags };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-31T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, 'W29 review round 3']);
  await seedPayrollCompany(pool, co, 20000);
  salary = String((await pool.query("SELECT id FROM payroll_components WHERE company_id=$1 AND name='Basic Salary'", [co])).rows[0].id);
  for (const [shape, rows] of Object.entries(SHAPES)) for (const [where, end] of Object.entries(ENDS)) await emp(`${shape}-${where}`, end, rows(end));
  // R3-L3: a weekly leaver (last day Wednesday 10 June) whose own row ends on that day, in the week of 6-12 June.
  await emp('W-LEAVER', '2026-06-10', [{ amount: 6000, from: '2020-01-01', to: '2026-06-10', recurring: true }], 'weekly');
  // June's weekly run first: July's SDL basis reads it (a later calculation of June would leave July's stale).
  await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,pay_frequency,period_start,period_end)
    VALUES($1,$2,6,2026,'draft','weekly','2026-06-06','2026-06-12')`, [wk, co]);
  await calculatePayrollRun(wk, co);
  await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,7,2026,'draft')", [jul, co]);
  await calculatePayrollRun(jul, co);
});

afterAll(async () => { vi.useRealTimers(); try { await cleanPayrollCompanies(pool, [co]); } finally { await pool.end(); } });

describe('one successor predicate: pay and guard agree, whichever reader meets the leaver row', () => {
  it.each(Object.keys(SHAPES))('%s: leaving on the 28th (band) and on the 15th pay the same and flag the same', async (shape) => {
    const band = await lineOf(jul, `${shape}-band`);
    const mid = await lineOf(jul, `${shape}-mid`);
    expect(band, 'band').toEqual({ gross: WANT[shape]!.gross, flags: WANT[shape]!.flags });
    expect(mid, 'mid').toEqual(band);
  });

  it('approval is refused naming the flagged leavers, and not the GAP leavers for their own rows', async () => {
    const b = (await judgePayrollApproval(co, jul))?.blocker;
    expect(b?.code).toBe('recurring_needs_pro_rata');
    for (const n of ['NEXT-band', 'NEXT-mid', 'PKG-band', 'PKG-mid', 'PRE953-band', 'PRE953-mid']) expect(b!.detail).toContain(`${n} Basic Salary`);
    expect(b!.detail).toContain("GAP-mid Basic Salary starts on 2026-07-17, after the employee's last day");
  });
});

describe('R3-L3: a weekly leaver', () => {
  it('whose own row ends on their last day mid-week is paid the whole week, not flagged', async () => {
    expect(await lineOf(wk, 'W-LEAVER')).toEqual({ gross: 6000, flags: [] });
  });
});
