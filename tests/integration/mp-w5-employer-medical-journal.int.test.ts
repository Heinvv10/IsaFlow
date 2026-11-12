/**
 * runEmployerMedical on real Postgres (wave 5 FB review): only a NON-CASH 3810 item counts. A gross-up line keeps its 3810 as
 * cash (no isNonCash flag) and is already in gross pay, so it must not be booked a second time. Another company's run is empty.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runEmployerMedical } from '../../src/modules/accounting/services/payroll/payrollJournalEmployerMedical';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
let runId = '';
const emp: Record<string, string> = {};
const item = (code: string, amount: number, nonCash: boolean) => ({
  componentId: code, componentName: code, sarsSourceCode: code, amount, isTaxable: true, isUifApplicable: false, ...(nonCash ? { isNonCash: true } : {}),
});

beforeAll(async () => {
  for (const c of [company, other]) await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [c, `EM ${c.slice(0, 8)}`]);
  runId = (await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross) VALUES ($1, 3, 2026, 'approved', 0) RETURNING id`, [company])).rows[0]!.id;
  for (const [n, items] of [
    ['split', [item('3601', 10_000, false), item('3810', 2_000, true), item(' 3810 ', 500, true)]],
    ['grossup', [item('3601', 10_000, false), item('3810', 2_000, false)]],
    ['none', [item('3601', 10_000, false)]],
  ] as const) {
    emp[n] = (await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1, $2, 'E', $2, '2020-01-01') RETURNING id`, [company, n])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
       VALUES ($1, $2, 10000, 10000, 0, 0, 0, 0, $3::jsonb)`, [runId, emp[n], JSON.stringify(items)]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [runId]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[company, other]]);
  } finally { await pool.end(); }
});

describe('runEmployerMedical', () => {
  it('returns only the non-gross-up employee: a padded code is trimmed, a cash 3810 is not counted', async () => {
    const m = await runEmployerMedical(company, runId);
    expect([...m.entries()]).toEqual([[emp.split, 2500]]);
  });
  it('is scoped to the company: the same run id under another company is empty', async () => {
    expect((await runEmployerMedical(other, runId)).size).toBe(0);
  });
});
