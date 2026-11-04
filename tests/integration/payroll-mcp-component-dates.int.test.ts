/**
 * The MCP payroll tools against a real database, then a real pay run (#1057 + this branch). Run in TZ=Africa/Johannesburg
 * (and UTC): before #1057 the MCP built a local-midnight Date and the service stored it through toISOString(), one day
 * early in SAST, so a once-off assigned for 1 December landed on 30 November and was paid in November's run.
 *   - assign_employee_component: a once-off from 2026-12-01 is paid in December, not November; a recurring row from
 *     the 1st is not flagged for a pro-rata.
 *   - end_employee_component with cancel: an assignment no approved run has paid is voided (L1); a paid one is refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { assignEmployeeComponentTool, endEmployeeComponentTool } from '@/lib/mcp/tools/writeEmployees';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const salary = crypto.randomUUID();
const bonus = crypto.randomUUID();
const runs = { nov: crypto.randomUUID(), dec: crypto.randomUUID() } as const;
const ctx = () => ({ companyId: company, userId: user, scopes: ['write:payroll'], companyRole: 'owner', tokenJti: null, oauthAppId: null });
type ToolOut = { isError?: boolean; content: Array<{ text: string }> };

async function tool(t: { handler: (a: Record<string, unknown>, c: never) => Promise<unknown> }, args: Record<string, unknown>) {
  const out = await t.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx() as never) as ToolOut;
  return { isError: out.isError === true, body: out.content[0]!.text };
}
async function line(run: string) {
  await calculatePayrollRun(run, company);
  const { rows } = await pool.query('SELECT component_breakdown, validation_results FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, employee]);
  const r = rows[0] as { component_breakdown: Array<{ componentName: string; amount: number }>; validation_results: Array<{ code: string }> } | undefined;
  return { paid: (r?.component_breakdown ?? []).map(c => [c.componentName, Number(c.amount)]), codes: (r?.validation_results ?? []).map(v => v.code) };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-31T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'MCP component dates']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name, code] of [[salary, 'Basic salary', '3601'], [bonus, 'Bonus', '3605']]) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,$3,$4,'earning',true,true,true)`, [id, company, name, code]);
  }
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,'MCP-1','Mcp','Dates','2020-01-01','active',false)`, [employee, company]);
  for (const [id, month] of [[runs.nov, 11], [runs.dec, 12]] as const) {
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')", [id, company, month]);
  }
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [Object.values(runs)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=$1', [employee]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe(`assign_employee_component (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it('a recurring salary from 1 December and a once-off from 1 December: stored as given', async () => {
    expect((await tool(assignEmployeeComponentTool, { employee_id: employee, component_id: salary, amount: 20000, effective_from: '2026-12-01' })).isError).toBe(false);
    expect((await tool(assignEmployeeComponentTool, { employee_id: employee, component_id: bonus, amount: 1500, effective_from: '2026-12-01', is_recurring: false })).isError).toBe(false);
    const { rows } = await pool.query(
      "SELECT is_recurring, to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE employee_id=$1 ORDER BY is_recurring",
      [employee]);
    expect(rows).toEqual([{ is_recurring: false, f: '2026-12-01', t: '2026-12-31' }, { is_recurring: true, f: '2026-12-01', t: null }]);
  });

  it('the once-off is paid in December, not November; the salary from the 1st is not flagged', async () => {
    expect((await line(runs.nov)).paid).toEqual([]);
    const dec = await line(runs.dec);
    expect(dec.paid.sort()).toEqual([['Basic salary', 20000], ['Bonus', 1500]]);
    expect(dec.codes).not.toContain('RECURRING_NEEDS_PRO_RATA');
  });
});

describe('end_employee_component cancels what no approved run has paid (L1)', () => {
  it('a recurring row starting in January, cancelled through MCP: voided', async () => {
    await tool(assignEmployeeComponentTool, { employee_id: employee, component_id: bonus, amount: 900, effective_from: '2027-01-15' });
    const { rows } = await pool.query("SELECT id FROM payroll_employee_components WHERE employee_id=$1 AND effective_from='2027-01-15'", [employee]);
    const out = await tool(endEmployeeComponentTool, { assignment_id: rows[0].id, effective_to: '2027-01-15', cancel: true });
    expect(out.isError, out.body).toBe(false);
    const after = (await pool.query('SELECT effective_to < effective_from AS voided FROM payroll_employee_components WHERE id=$1', [rows[0].id])).rows[0];
    expect(after.voided).toBe(true);
  });
});
