/**
 * W29 (wave 7 PRA; rulings 7, 13, 19) on real rows: a monthly run pays a recurring earning that starts or ends strictly
 * inside employment its share of the month's working days (payrollRecurringShareRead + payrollRecurringShare), stores the
 * share on the breakdown item (the payslip prints it), and the pro-rata guard stops flagging it. A starter's own row and a
 * leaver's own row keep full pay; a deduction starting in the band is still flagged. Two tenants (the second at 10x the
 * amounts), and a later month in which the ended row is not read again.
 * July 2026: 23 working days (1 July is a Wednesday); 1-15 July = 11, 16-31 July = 12.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany } from './w3-01-payroll.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';
import { itemisePayslip } from '@/modules/accounting/services/payroll/payslipItems';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tenants = [
  { id: crypto.randomUUID(), scale: 1, jul: crypto.randomUUID(), aug: crypto.randomUUID(), salary: '', dues: '', ids: {} as Record<string, string> },
  { id: crypto.randomUUID(), scale: 10, jul: crypto.randomUUID(), aug: crypto.randomUUID(), salary: '', dues: '', ids: {} as Record<string, string> },
];
type Tenant = typeof tenants[number];
const r2 = (n: number) => Math.round(n * 100) / 100;

async function employee(t: Tenant, num: string, start: string, end: string | null, rows: Array<[number, string, string | null, 'salary' | 'dues']>) {
  const id = crypto.randomUUID();
  t.ids[num] = id;
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Share','Test',$4::date,$5::date,'active',false)`, [id, t.id, num, start, end]);
  for (const [amount, from, to, which] of rows) {
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
       VALUES($1,$2,$3,$4::date,$5::date,true)`, [id, which === 'salary' ? t.salary : t.dues, amount * t.scale, from, to]);
  }
}

async function line(t: Tenant, run: string, num: string) {
  const { rows } = await pool.query(
    `SELECT gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif_employee, uif_employer::float8 AS uif_employer,
            sdl::float8 AS sdl, net_pay::float8 AS net, component_breakdown, validation_results
       FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2`, [run, t.ids[num]]);
  return rows[0] as { gross: number; paye: number; uif_employee: number; uif_employer: number; sdl: number; net: number;
    component_breakdown: Array<{ amount: number; componentName: string; share?: { days: number; of: number; share: number; fullAmount: number } }>;
    validation_results: Array<{ code: string; message: string }> } | undefined;
}
const flags = (l: Awaited<ReturnType<typeof line>>) => (l?.validation_results ?? []).filter(v => v.code === 'RECURRING_NEEDS_PRO_RATA');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-31T12:00:00+02:00'));
  for (const t of tenants) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [t.id, `W7 PRA share x${t.scale}`]);
    await seedPayrollCompany(pool, t.id, 20000 * t.scale);
    t.salary = String((await pool.query("SELECT id FROM payroll_components WHERE company_id=$1 AND name='Basic Salary'", [t.id])).rows[0].id);
    t.dues = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable) VALUES($1,$2,'Union dues','4018','deduction',false)`,
      [t.dues, t.id]);
    // A raise on 16 July: the old row ends on the 15th inside employment, the new one starts on the 16th.
    await employee(t, 'S-RAISE', '2020-01-01', null, [[20000, '2020-01-01', '2026-07-15', 'salary'], [22000, '2026-07-16', null, 'salary']]);
    await employee(t, 'S-STARTER', '2026-07-16', null, [[20000, '2026-07-16', null, 'salary']]);
    await employee(t, 'S-LEAVER', '2020-01-01', '2026-07-28', [[20000, '2020-01-01', '2026-07-28', 'salary']]);
    await employee(t, 'S-DUES29', '2020-01-01', null, [[20000, '2020-01-01', null, 'salary'], [100, '2026-07-29', null, 'dues']]);
    for (const [run, month] of [[t.jul, 7], [t.aug, 8]] as const) {
      await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')", [run, t.id, month]);
      await calculatePayrollRun(run, t.id);
    }
  }
});

afterAll(async () => {
  vi.useRealTimers();
  try { await cleanPayrollCompanies(pool, tenants.map(t => t.id)); } finally { await pool.end(); }
});

describe.each(tenants)('tenant x$scale', (t) => {
  it('a mid-month raise pays 11 of 23 working days at the old rate and 12 of 23 at the new one', async () => {
    const l = await line(t, t.jul, 'S-RAISE');
    const old = r2(20000 * t.scale * 11 / 23);
    const raised = r2(22000 * t.scale * 12 / 23);
    expect(l?.gross).toBe(r2(old + raised));
    expect(l?.component_breakdown.map(i => ({ amount: i.amount, share: i.share && { days: i.share.days, of: i.share.of, fullAmount: i.share.fullAmount } }))
      .sort((a, b) => a.amount - b.amount)).toEqual([
      { amount: old, share: { days: 11, of: 23, fullAmount: 20000 * t.scale } },
      { amount: raised, share: { days: 12, of: 23, fullAmount: 22000 * t.scale } },
    ].sort((a, b) => a.amount - b.amount));
    expect(flags(l)).toEqual([]);
  });

  it('the payslip line says the share', async () => {
    const l = await line(t, t.jul, 'S-RAISE');
    const types = new Map([[t.salary, 'earning']]);
    const slip = itemisePayslip({ grossPay: l!.gross, paye: l!.paye, uifEmployee: l!.uif_employee, uifEmployer: l!.uif_employer, sdl: l!.sdl,
      netPay: l!.net, breakdown: l!.component_breakdown }, types);
    expect(slip.earnings.map(e => e.label).sort()).toEqual(['Basic Salary, 11 of 23 working days (0.4782)', 'Basic Salary, 12 of 23 working days (0.5217)']);
  });

  it("ruling 19: a starter's and a leaver's own rows keep full-month pay", async () => {
    for (const num of ['S-STARTER', 'S-LEAVER']) {
      const l = await line(t, t.jul, num);
      expect(l?.gross, num).toBe(20000 * t.scale);
      expect(l?.component_breakdown.every(i => i.share === undefined), num).toBe(true);
    }
    // The starter's row starts after the 27th? No: on the 16th, outside the band, so it is not flagged either.
    expect(flags(await line(t, t.jul, 'S-STARTER'))).toEqual([]);
  });

  it('a deduction starting in the band is still flagged and refuses approval; the apportioned employees are not named', async () => {
    expect(flags(await line(t, t.jul, 'S-DUES29')).map(f => f.message)).toEqual([expect.stringContaining('Union dues starts on 2026-07-29')]);
    const b = (await judgePayrollApproval(t.id, t.jul))?.blocker;
    expect(b?.code).toBe('recurring_needs_pro_rata');
    expect(b!.detail).toContain('S-DUES29 Union dues starts on 2026-07-29');
    for (const n of ['S-RAISE', 'S-STARTER', 'S-LEAVER', 'W301-1']) expect(b!.detail).not.toContain(n);
  });

  it('August, a later window: the raise pays in full, the ended row is not read again, nothing is apportioned', async () => {
    const l = await line(t, t.aug, 'S-RAISE');
    expect(l?.gross).toBe(22000 * t.scale);
    expect(l?.component_breakdown.map(i => i.share)).toEqual([undefined]);
    expect(await line(t, t.aug, 'S-LEAVER')).toBeUndefined();
  });

  it("each run holds its own tenant's employees only", async () => {
    const other = tenants.find(o => o !== t)!;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id=$1 AND employee_id = ANY($2::uuid[])',
      [t.jul, Object.values(other.ids)]);
    expect(rows[0].n).toBe(0);
  });
});
