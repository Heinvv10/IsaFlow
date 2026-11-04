/**
 * A pay run reads its employees' components as at the LAST day of its period.
 *
 * Before: calculatePayrollRun built `new Date(year, month - 1, 28)` at local midnight and getEmployeeComponents
 * rendered it with toISOString(), so on the SAST production host every run read as at the 27th. A once-off is stored
 * from its own date to its own month end, so one dated the 28th or later was in no run's window and was never paid,
 * with no warning (on a UTC host, from the 29th). After: the read date is the period's last day as a plain string.
 *
 * One read date for every row, recurring or not: supersedes (payPackageService, an ended salary followed by a new
 * one) leave contiguous windows on the same component, and a single read day pays exactly one of them. Reading
 * once-offs by the whole month while reading recurring rows on another day pays both rows of such a pair (the
 * mixed-flag case below).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const runs = { feb: crypto.randomUUID(), mar: crypto.randomUUID(), apr: crypto.randomUUID() } as const;
const salary = crypto.randomUUID();
const bonus = crypto.randomUUID();
const allowance = crypto.randomUUID();
const emp = {
  onceOff28: crypto.randomUUID(), onceOff29: crypto.randomUUID(), onceOff30: crypto.randomUUID(),
  onceOff31: crypto.randomUUID(), febOnceOff28: crypto.randomUUID(), starts30: crypto.randomUUID(),
  changes29: crypto.randomUUID(), mixedFlags: crypto.randomUUID(), voided: crypto.randomUUID(),
} as const;
const SALARY = 20000;

async function addEmployee(id: string, num: string, start = '2020-01-01') {
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Read',$3,$4::date,'active',true)`,
    [id, company, num, start],
  );
}

async function assign(employee: string, component: string, amount: number, from: string, to: string | null, recurring: boolean) {
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,$3,$4::date,$5::date,$6)`,
    [employee, component, amount, from, to, recurring],
  );
}

/** What each employee's line in the run pays, as [component, amount], sorted. */
async function paid(runId: string, employee: string): Promise<Array<[string, number]>> {
  const { rows } = await pool.query(
    'SELECT component_breakdown FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2',
    [runId, employee],
  );
  expect(rows, 'employee has no line on the run').toHaveLength(1);
  return (rows[0].component_breakdown as Array<{ componentName: string; amount: number }>)
    .map((c): [string, number] => [c.componentName, Number(c.amount)])
    .sort(([a, x], [b, y]) => a.localeCompare(b) || x - y);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-04-30T12:00:00+02:00'));

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Read-date fixture']);
  for (const [id, name, code] of [[salary, 'Basic salary', '3601'], [bonus, 'Once-off bonus', '3605'], [allowance, 'Allowance', '3713']]) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,$3,$4,'earning',true,true,true)`,
      [id, company, name, code],
    );
  }

  // Once-offs as every writer stores them: from their own date to their own month end.
  for (const [id, day] of [[emp.onceOff28, 28], [emp.onceOff29, 29], [emp.onceOff30, 30], [emp.onceOff31, 31]] as const) {
    await addEmployee(id, `RD-ONCE-${day}`);
    await assign(id, salary, SALARY, '2020-01-01', null, true);
    await assign(id, bonus, 1000 + day, `2026-03-${day}`, '2026-03-31', false);
  }
  await addEmployee(emp.febOnceOff28, 'RD-FEB-28');
  await assign(emp.febOnceOff28, salary, SALARY, '2020-01-01', null, true);
  await assign(emp.febOnceOff28, bonus, 2028, '2026-02-28', '2026-02-28', false);

  // Recurring rows bounded inside the 28th..31st band: these figures change, by design.
  await addEmployee(emp.starts30, 'RD-STARTS-30', '2026-03-30');
  await assign(emp.starts30, salary, SALARY, '2026-03-30', null, true);
  await addEmployee(emp.changes29, 'RD-CHANGES-29');
  await assign(emp.changes29, salary, SALARY, '2020-01-01', '2026-03-28', true);
  await assign(emp.changes29, salary, SALARY + 500, '2026-03-29', null, true);

  // A pay package applied on 30 March with the allowance as a once-off: the standing allowance is ended the day
  // before (payPackageService supersede), the once-off runs to the month end.
  await addEmployee(emp.mixedFlags, 'RD-MIXED');
  await assign(emp.mixedFlags, salary, SALARY, '2020-01-01', null, true);
  await assign(emp.mixedFlags, allowance, 700, '2025-01-01', '2026-03-29', true);
  await assign(emp.mixedFlags, allowance, 900, '2026-03-30', '2026-03-31', false);

  // A future row cancelled by a supersede (empty window): never paid.
  await addEmployee(emp.voided, 'RD-VOIDED');
  await assign(emp.voided, salary, SALARY, '2020-01-01', null, true);
  await assign(emp.voided, bonus, 999, '2026-03-30', '2026-03-29', false);

  for (const [id, month] of [[runs.feb, 2], [runs.mar, 3], [runs.apr, 4]] as const) {
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')`,
      [id, company, month],
    );
    await calculatePayrollRun(id, company);
  }
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

describe(`a once-off dated anywhere in the month is paid in that month's run (TZ=${process.env.TZ ?? 'unset'})`, () => {
  for (const day of [28, 29, 30, 31] as const) {
    const id = emp[`onceOff${day}`];
    it(`dated ${day} March: paid in March, once`, async () => {
      expect(await paid(runs.mar, id)).toEqual([['Basic salary', SALARY], ['Once-off bonus', 1000 + day]]);
    });
    it(`dated ${day} March: not paid in February or April`, async () => {
      expect(await paid(runs.feb, id)).toEqual([['Basic salary', SALARY]]);
      expect(await paid(runs.apr, id)).toEqual([['Basic salary', SALARY]]);
    });
  }

  it('dated 28 February, the last day of a 28-day month: paid in February, not in March', async () => {
    expect(await paid(runs.feb, emp.febOnceOff28)).toEqual([['Basic salary', SALARY], ['Once-off bonus', 2028]]);
    expect(await paid(runs.mar, emp.febOnceOff28)).toEqual([['Basic salary', SALARY]]);
  });
});

describe('recurring rows bounded between the 28th and the month end (changed by design)', () => {
  it('a salary starting on 30 March is paid in full in March (no part-month reduction, as for any start)', async () => {
    expect(await paid(runs.mar, emp.starts30)).toEqual([['Basic salary', SALARY]]);
    expect(await paid(runs.apr, emp.starts30)).toEqual([['Basic salary', SALARY]]);
  });

  it('a salary change from 29 March: March pays the new salary only, never both, never neither', async () => {
    expect(await paid(runs.feb, emp.changes29)).toEqual([['Basic salary', SALARY]]);
    expect(await paid(runs.mar, emp.changes29)).toEqual([['Basic salary', SALARY + 500]]);
  });
});

describe('one read date for recurring and once-off rows', () => {
  it('a standing allowance superseded by a once-off on 30 March is paid once in March: the once-off', async () => {
    expect(await paid(runs.feb, emp.mixedFlags)).toEqual([['Allowance', 700], ['Basic salary', SALARY]]);
    expect(await paid(runs.mar, emp.mixedFlags)).toEqual([['Allowance', 900], ['Basic salary', SALARY]]);
    expect(await paid(runs.apr, emp.mixedFlags)).toEqual([['Basic salary', SALARY]]);
  });

  it('a row voided by a supersede (window ends before it starts) is never paid', async () => {
    for (const run of Object.values(runs)) {
      expect(await paid(run, emp.voided)).toEqual([['Basic salary', SALARY]]);
    }
  });
});
