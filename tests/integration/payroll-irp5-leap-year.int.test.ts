/**
 * The IRP5 summary and the e@syFile export end the tax year on the last day of
 * February, the 29th in a leap year (taxYear=2028 ends 2028-02-29): a severance
 * directive effective on 29 February 2028 counts for the summary of 2028 and
 * not of 2027, and a lump sum paid outside payroll on 29 February 2028 is on
 * the 2028 file and not the 2027 one; the EMP501 CSV takes February 2028 into
 * 2028 and March 2028 into 2029. Real routes on a disposable Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import summary from '../../pages/api/payroll/irp5/summary';
import emp501Export from '../../pages/api/payroll/emp501/export';
import emp501Reconciliation from '../../pages/api/payroll/emp501/reconciliation';
import { createTaxDirective, updateTaxDirectiveStatus } from '@/modules/accounting/services/payroll/taxDirectiveService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import { applyStandalone, approvedDirective, cleanSeveranceFixtures, seedRetrenchedEmployee, type SeveranceFixture } from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let f: SeveranceFixture;

const SARS_PROFILE = `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
  sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
  physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`;

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2028-02-29', 'IRP5 leap year');
  await pool.query(SARS_PROFILE, [f.company]);
  // A severance component on the employee, so the summary asks for an approved severance directive.
  const comp = (await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
     VALUES ($1, 'Severance', '3901', 'earning') RETURNING id`, [f.company])).rows[0].id;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 0, '2020-01-01')`,
    [f.employee, comp]);
  // An approved January 2028 run, so the employee has remuneration in the 2028 year.
  const run = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_run_headers(id, company_id, period_month, period_year, status, total_gross, total_paye)
     VALUES ($1, $2, 1, 2028, 'approved', 20000, 2115)`, [run, f.company]);
  await pool.query(
    `INSERT INTO payroll_run_lines(run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, net_pay)
     VALUES ($1, $2, 20000, 20000, 2115, 0, 0, 0, 17885)`, [run, f.employee]);
  await approvedDirective(f, 30_000, 0.1, '2028-02-29');
  // A lump sum under its own directive, paid outside payroll on the leap day.
  const lump = await createTaxDirective(f.company, {
    employee_id: f.employee, employee_name: 'Wanda Test', directive_number: '5550002222', directive_type: 'lump_sum',
    amount: 12_000, tax_rate: 0.25, effective_date: '2028-02-10',
  }, f.admin);
  await updateTaxDirectiveStatus(f.company, lump.id, 'approved', f.admin);
  const paid = await applyStandalone(f, lump.id, '2028-02-29');
  expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f].filter(Boolean)); } finally { await pool.end(); }
});

async function getSummary(taxYear: number) {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = `/api/payroll/irp5/summary?taxYear=${taxYear}`;
  req.query = { taxYear: String(taxYear) };
  const out = response();
  await (summary as Route)(req as never, out.res as never);
  return { status: out.state.statusCode, body: out.state.body as { data?: { employees: Array<{ messages: Array<{ code: string }> }> } } };
}

async function getExport(taxYear: number) {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = `/api/payroll/irp5/easyfile-export?taxYear=${taxYear}`;
  req.query = { taxYear: String(taxYear) };
  const out = response();
  let file = '';
  out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
  await (easyfile as Route)(req as never, out.res as never);
  return { status: out.state.statusCode, file, body: out.state.body };
}

async function getEmp501Csv(taxYear: number): Promise<string> {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = `/api/payroll/emp501/export?taxYear=${taxYear}`;
  req.query = { taxYear: String(taxYear) };
  const out = response();
  let csv = '';
  out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') csv = body; return this; };
  out.state.send = function send(this: typeof out.state, body?: unknown) { if (typeof body === 'string') csv = body; return this; };
  await (emp501Export as Route)(req as never, out.res as never);
  return csv;
}

async function getReconciliation(taxYear: number) {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = `/api/payroll/emp501/reconciliation?taxYear=${taxYear}`;
  req.query = { taxYear: String(taxYear) };
  const out = response();
  await (emp501Reconciliation as Route)(req as never, out.res as never);
  expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
  return (out.state.body as { data: { totalEmp201: number; totalIrp5: number; rows: Array<{ month: number; year: number; emp201Paye: number }> } }).data;
}

describe('the tax year ends on 29 February in a leap year', () => {
  it('summary: a severance directive effective 2028-02-29 is on file for 2028, not for 2027', async () => {
    const codes = async (y: number) => {
      const r = await getSummary(y);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data!.employees[0]!.messages.map((m) => m.code);
    };
    expect(await codes(2028)).not.toContain('IRP5_SEVERANCE_WITHOUT_DIRECTIVE');
    // The directive is effective after 2027 ended: for that year the employee has run pay but no directive in force.
    const dec = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payroll_run_headers(id, company_id, period_month, period_year, status, total_gross, total_paye)
       VALUES ($1, $2, 12, 2026, 'approved', 20000, 2115)`, [dec, f.company]);
    await pool.query(
      `INSERT INTO payroll_run_lines(run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, net_pay)
       VALUES ($1, $2, 20000, 20000, 2115, 0, 0, 0, 17885)`, [dec, f.employee]);
    try {
      expect(await codes(2027)).toContain('IRP5_SEVERANCE_WITHOUT_DIRECTIVE');
    } finally {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [dec]);
      await pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [dec]);
    }
  });

  it('e@syFile: a lump sum paid on 2028-02-29 is on the 2028 file and leaves the 2027 file empty', async () => {
    const leap = await getExport(2028);
    expect(leap.status, JSON.stringify(leap.body)).toBe(200);
    expect(leap.file).toContain('3907,12000');
    const before = await getExport(2027);
    expect(before.status).toBe(400);
    expect(JSON.stringify(before.body)).toMatch(/No employees with payroll activity/);
  });

  it('EMP501 CSV: February 2028 is in tax year 2028 and March 2028 is not', async () => {
    const extra: string[] = [];
    for (const [month, gross] of [[2, 10_000], [3, 5_000]] as const) {
      const paye = gross / 20;
      const id = crypto.randomUUID();
      extra.push(id);
      await pool.query(
        `INSERT INTO payroll_run_headers(id, company_id, period_month, period_year, status, total_gross, total_paye)
         VALUES ($1, $2, $3, 2028, 'approved', $4, $5)`, [id, f.company, month, gross, paye]);
      await pool.query(
        `INSERT INTO payroll_run_lines(run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, net_pay)
         VALUES ($1, $2, $3, $3, $4, 0, 0, 0, $3)`, [id, f.employee, gross, paye]);
    }
    try {
      // January 20 000 + February 10 000; the March 5 000 belongs to the 2029 tax year.
      expect(await getEmp501Csv(2028)).toContain(',30000.00,');
      expect(await getEmp501Csv(2029)).toContain(',5000.00,');
      // The reconciliation: January 2 115 + February 500 PAYE in 2028 (March's 250 is not), both ways.
      const y2028 = await getReconciliation(2028);
      expect(y2028.rows.find((r) => r.month === 2 && r.year === 2028)!.emp201Paye).toBe(500);
      expect([y2028.totalEmp201, y2028.totalIrp5]).toEqual([2615, 2615]);
      expect((await getReconciliation(2029)).totalEmp201).toBe(250);
    } finally {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id = ANY($1)', [extra]);
      await pool.query('DELETE FROM payroll_run_headers WHERE id = ANY($1)', [extra]);
    }
  });
});
