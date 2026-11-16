/**
 * Wave 6 FQb1, review #1507 round 4 (ledger D1/D2, folded; D3 added for arch's M): does the SDL month gate's 'stored'
 * re-judgement agree with what calculatePayrollRun decided? A just-calculated run must never be named stale by the gate
 * (no drift between the two readings of the month), across months either side of the R500 000 line, on the line to the
 * cent, and with a non-cash benefit and an independent contractor on the run. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { sdlMonthSplitRefusal } from '@/modules/accounting/services/payroll/payrollSdlMonthGate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const companies: string[] = [];

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00')); });
afterAll(async () => {
  vi.useRealTimers();
  try {
    for (const c of companies) {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id=$1)', [c]);
      await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id=$1)', [c]);
      await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM companies WHERE id=$1', [c]);
    }
  } finally { await pool.end(); }
});

/** Months calculated by the real writer; after each, the gate's verdict on that run (null = agrees). */
interface Extras { nonCash3810?: number; contractorFee?: number }

async function months(name: string, salaries: Array<[number, number]>, approve = true, extras: Extras = {}): Promise<Array<{ exempt: boolean; gate: string | null }>> {
  const company = crypto.randomUUID();
  companies.push(company);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, name]);
  const salary = String((await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_sdl_applicable)
     VALUES ($1, 'Basic salary', '3601', 'earning', true) RETURNING id`, [company])).rows[0]!.id);
  const employee = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,date_of_birth,status,
       medical_aid_main_member,medical_aid_dependants_count)
     VALUES($1,$2,'DR-1','Drift','Check','2020-01-01','1980-06-15','active',false,0)`, [employee, company]);
  if (extras.nonCash3810) {
    // The employer's medical contribution: a 3810 earning, never cash (employerContributions.markNonCashEmployerBenefits).
    await pool.query('UPDATE payroll_employees SET medical_aid_main_member = true WHERE id = $1', [employee]);
    const medical = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable, is_sdl_applicable)
       VALUES ($1, 'Medical aid (employer)', '3810', 'earning', true, true) RETURNING id`, [company])).rows[0]!.id);
    await pool.query("INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')",
      [employee, medical, extras.nonCash3810]);
  }
  if (extras.contractorFee) {
    // An independent contractor's fee: not remuneration for the s4(b) threshold on either side.
    const contractor = String((await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number, tax_status)
       VALUES ($1, 'DR-C', 'Conn', 'Tractor', '2020-01-01', '1980-01-01', '0123456780', 'independent_contractor') RETURNING id`, [company])).rows[0]!.id);
    await pool.query("INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')",
      [contractor, salary, extras.contractorFee]);
  }
  const out: Array<{ exempt: boolean; gate: string | null }> = [];
  for (const [m, amount] of salaries) {
    const from = `2026-${String(m).padStart(2, '0')}-01`;
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
       VALUES($1,$2,$3,$4::date,($4::date + INTERVAL '27 days')::date,false)`, [employee, salary, amount, from]);
    const run = crypto.randomUUID();
    await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')`, [run, company, m]);
    await calculatePayrollRun(run, company);
    const exempt = (await pool.query('SELECT bool_or(sdl_exempt) AS e FROM payroll_run_lines WHERE run_id=$1', [run])).rows[0].e as boolean;
    out.push({ exempt, gate: (await sdlMonthSplitRefusal(company, run))?.detail ?? null });
    if (approve) await pool.query(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [run]);
  }
  return out;
}

describe('D the gate re-judges a just-calculated run as the calculation did', () => {
  it('D1 exempt, liable, exempt months: no run is stale right after calculation', async () => {
    const got = await months('drift D1', [[3, 10_000], [4, 90_000], [5, 1_000]]);
    expect(got.map((g) => g.gate)).toEqual([null, null, null]);
    expect(got.map((g) => g.exempt)).toEqual([true, false, true]); // May: (10 000 + 90 000 + 1 000) / 3 x 12 = 404 000
  });

  it('D2 on the R500 000 line (41 666.67 a month): the gate and the calculation agree', async () => {
    const got = await months('drift D2', [[3, 41_666.67], [3 + 1, 41_666.66]]);
    expect(got.map((g) => g.gate)).toEqual([null, null]);
  });

  // Arch's M: the gate's stored figure (total_gross - contractor gross + flagged non-cash) against the costed one
  // (allEarnings of the non-contractor lines), on the line: 40 166.67 salary + 1 500.00 non-cash 3810 = 41 666.67 a
  // month (500 000.04 a year, liable), with a R9 000 contractor fee that must count on neither side.
  it('D3 on the line with a non-cash 3810 and a contractor on the run: the gate and the calculation agree', async () => {
    const got = await months('drift D3', [[3, 40_166.67], [4, 40_166.67]], true, { nonCash3810: 1_500, contractorFee: 9_000 });
    expect(got).toEqual([{ exempt: false, gate: null }, { exempt: false, gate: null }]);
  });
});
