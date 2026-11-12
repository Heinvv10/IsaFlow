/**
 * The pay-run read date moved from "the 28th through toISOString" (the 27th on the SAST host) to the period's last
 * day, as a plain string. For a run in which no component starts or ends between the 27th and the month end, that
 * move must change nothing: every line and every header total below was captured from master (before the fix) and
 * must come out byte-identical after it, in SAST and in UTC.
 *
 * The fixture is an ordinary payroll: standing salary, allowance, retirement and medical deductions, a salary
 * increase that starts on the 1st, once-offs dated mid-month, a deduction that ends mid-month, a mid-month starter
 * and a young employee (ETI), over a 28-day February and a 31-day March.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { EXPECTED_HEADERS, EXPECTED_LINES } from './payroll-run-read-date-figures.expected';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const runs = { feb: crypto.randomUUID(), mar: crypto.randomUUID(), apr: crypto.randomUUID() } as const;
const comp = {
  salary: crypto.randomUUID(), travel: crypto.randomUUID(), overtime: crypto.randomUUID(),
  bonus: crypto.randomUUID(), pension: crypto.randomUUID(), medical: crypto.randomUUID(), union: crypto.randomUUID(),
} as const;
const emp = {
  steady: crypto.randomUUID(), increase: crypto.randomUUID(), young: crypto.randomUUID(),
  endsMid: crypto.randomUUID(), starter: crypto.randomUUID(),
} as const;
const labelOf = new Map<string, string>(Object.entries(emp).map(([label, id]) => [id, label]));
// Ids are random per run; the pinned figures name them instead.
const idLabels = [...Object.entries(emp), ...Object.entries(comp)];
const scrub = (text: string) => idLabels.reduce((t, [label, id]) => t.split(id).join(`<${label}>`), text);

async function addComponent(id: string, name: string, code: string, type: 'earning' | 'deduction', taxable: boolean) {
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
     VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
    [id, company, name, code, type, taxable, type === 'earning'],
  );
}

async function addEmployee(id: string, num: string, start: string, born: string, medicalDependants: number, idNumber: string | null = null) {
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,date_of_birth,status,
       medical_aid_main_member,medical_aid_dependants_count,id_number)
     VALUES($1,$2,$3,'Read',$3,$4::date,$5::date,'active',true,$6,$7)`,
    [id, company, num, start, born, medicalDependants, idNumber],
  );
}

async function assign(employee: string, component: string, amount: number, from: string, to: string | null, recurring = true) {
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,$3,$4::date,$5::date,$6)`,
    [employee, component, amount, from, to, recurring],
  );
}

async function linesOf(runId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `SELECT employee_id, gross_pay, taxable_income, periodic_taxable, annual_taxable, paye, medical_credit,
            additional_medical_credit, medical_scheme_fees, uif_employee, uif_employer, sdl, eti, net_pay,
            component_breakdown::text AS component_breakdown,
            -- TS-b (calculation version 5) stores one info result on every hourless monthly line, HOURS_NOT_RECORDED, which master's
            -- output does not have. It is the ONLY code left out of the comparison; every other result stays byte-identical.
            (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements(validation_results) v
              WHERE v->>'code' <> 'HOURS_NOT_RECORDED')::text AS validation_results
       FROM payroll_run_lines WHERE run_id=$1`,
    [runId],
  );
  return Object.fromEntries(rows.map(({ employee_id, component_breakdown, validation_results, ...rest }) => [
    labelOf.get(String(employee_id)),
    { ...rest, component_breakdown: scrub(component_breakdown), validation_results: scrub(validation_results) },
  ]));
}

async function headerOf(runId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `SELECT total_gross, total_taxable, total_paye, total_uif, total_sdl, total_eti, total_net, employee_count
       FROM payroll_run_headers WHERE id=$1`,
    [runId],
  );
  return rows[0];
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-31T12:00:00+02:00'));

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Read-date figures fixture']);
  await addComponent(comp.salary, 'Basic salary', '3601', 'earning', true);
  await addComponent(comp.travel, 'Travel allowance', '3701', 'earning', true);
  await addComponent(comp.overtime, 'Overtime', '3602', 'earning', true);
  await addComponent(comp.bonus, 'Bonus', '3605', 'earning', true);
  await addComponent(comp.pension, 'Pension fund', '4001', 'deduction', true);
  await addComponent(comp.medical, 'Medical aid', '4005', 'deduction', true);
  await addComponent(comp.union, 'Union dues', '4018', 'deduction', false);

  await addEmployee(emp.steady, 'RD-STEADY', '2023-04-01', '1980-06-15', 2);
  await assign(emp.steady, comp.salary, 28500, '2023-04-01', null);
  await assign(emp.steady, comp.travel, 3000, '2025-07-01', null);
  await assign(emp.steady, comp.pension, 2280, '2023-04-01', null);
  await assign(emp.steady, comp.medical, 1950, '2023-04-01', null);

  // A salary increase from 1 March, a February bonus and a March overtime once-off, each closed at its month end.
  await addEmployee(emp.increase, 'RD-INCREASE', '2024-01-01', '1975-02-01', 0);
  await assign(emp.increase, comp.salary, 15000, '2024-01-01', '2026-02-28');
  await assign(emp.increase, comp.salary, 16500, '2026-03-01', null);
  await assign(emp.increase, comp.bonus, 10000, '2026-02-10', '2026-02-28', false);
  await assign(emp.increase, comp.overtime, 1200, '2026-03-12', '2026-03-31', false);

  // A valid SA ID number matching the date of birth (ETI Act s6(b), wave 5 ET): the suite keeps a positive ETI line.
  await addEmployee(emp.young, 'RD-YOUNG', '2025-09-01', '2002-05-20', 0, '0205205009082');
  await assign(emp.young, comp.salary, 6500, '2025-09-01', null);

  // Union dues stop on 15 March: paid in February, not in March, at either read date.
  await addEmployee(emp.endsMid, 'RD-ENDSMID', '2022-01-01', '1990-11-30', 0);
  await assign(emp.endsMid, comp.salary, 21000, '2022-01-01', null);
  await assign(emp.endsMid, comp.union, 180, '2022-01-01', '2026-03-15');

  // Starts 5 March: not on the February run, a full month in March (no part-month reduction).
  await addEmployee(emp.starter, 'RD-STARTER', '2026-03-05', '1995-08-08', 0);
  await assign(emp.starter, comp.salary, 18000, '2026-03-05', null);

  for (const [id, month] of [[runs.feb, 2], [runs.mar, 3]] as const) {
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')`,
      [id, company, month],
    );
  }
  await calculatePayrollRun(runs.feb, company);
  await calculatePayrollRun(runs.mar, company);
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [Object.values(runs)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=ANY($1::uuid[])', [Object.values(emp)]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally {
    await pool.end();
  }
});

describe(`a normal run is byte-identical to master's (TZ=${process.env.TZ ?? 'unset'})`, () => {
  for (const period of ['feb', 'mar'] as const) {
    it(`${period} 2026: every line, column by column`, async () => {
      expect(await linesOf(runs[period])).toEqual(EXPECTED_LINES[period]);
    });

    it(`${period} 2026: the header totals`, async () => {
      expect(await headerOf(runs[period])).toEqual(EXPECTED_HEADERS[period]);
    });
  }
});

describe('wave 5 ET: the no-identity-document path (ETI Act s6(b))', () => {
  it('RD-YOUNG with no SA ID number (and no permit recorded): no ETI, and an ETI_INDETERMINATE warning naming the document', async () => {
    await pool.query('UPDATE payroll_employees SET id_number = NULL WHERE id = $1', [emp.young]);
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,4,2026,'draft')`, [runs.apr, company]);
    await calculatePayrollRun(runs.apr, company);
    const young = (await linesOf(runs.apr)).young as { eti: string; validation_results: string };
    expect(young.eti).toBe('0.00');
    const codes = (JSON.parse(young.validation_results) as Array<{ code: string; message: string }>);
    expect(codes.find((v) => v.code === 'ETI_INDETERMINATE')?.message).toContain('a valid SA ID number, or an asylum seeker permit or refugee identity document recorded (ETI Act s6(b)) is missing');
  });
});
