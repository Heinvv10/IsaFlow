/**
 * Wave 6 EF: the EMP201, the IRP5 and the UI-19 select runs by FINALITY (`payRunFinalSql`: approved or paid AND
 * COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL), never by a status string, and the EMP201's UIF split
 * is the stored lines' own employee/employer sums, never half of `total_uif`.
 *
 * Real PG, two tenants, amounts ten times a normal month (so a halved split is far off), and pay months in tax year
 * 2029 (September to November 2028), a later-dated window than the other payroll suites. Seeded by hand: the
 * unequal UIF parts are a legacy-import shape, and an `approved` run with neither stamp is the shape only a hand
 * edit makes (reopen clears both stamps with the status; approval sets `approved_at` with it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { generateUifDeclaration, getUifDeclaration } from '@/modules/accounting/services/payroll/uifDeclarationService';
import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';
import { readEmployeeReadiness } from '@/modules/accounting/services/payroll/employeeReadinessRead';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const USER = crypto.randomUUID();
const emp: Record<string, string> = {};
const run: Record<string, string> = {};
const TAX_YEAR = 2029; // March 2028 to February 2029
const STAMPED = 'approved_at = clock_timestamp()';
const GRANDFATHERED = 'approval_grandfathered_at = clock_timestamp()';

async function employee(company: string, number: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, $2, 'Ef', $2, '2020-01-01') RETURNING id::text AS id`, [company, number])).rows[0]!.id;
}

type Line = { employee: string; gross: number; paye: number; uifEmployee: number; uifEmployer: number; sdl: number };

/** A header whose totals are its lines' sums, then set to `status` with `stamp` (or none). */
async function seedRun(company: string, month: number, status: string, stamp: string | null, lines: Line[]): Promise<string> {
  const sum = (k: keyof Omit<Line, 'employee'>) => lines.reduce((t, l) => t + l[k], 0);
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, employee_count,
       total_gross, total_paye, total_uif, total_sdl, total_net)
     VALUES ($1, $2, 2028, 'calculated', $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
    [company, month, lines.length, sum('gross'), sum('paye'), sum('uifEmployee') + sum('uifEmployer'), sum('sdl'),
      sum('gross') - sum('paye') - sum('uifEmployee')])).rows[0]!.id;
  for (const l of lines) {
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, net_pay)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $3::numeric - $4::numeric - $5::numeric)`,
      [id, l.employee, l.gross, l.paye, l.uifEmployee, l.uifEmployer, l.sdl]);
  }
  await pool.query(`UPDATE payroll_run_headers SET status = $2${stamp ? `, ${stamp}` : ''} WHERE id = $1`, [id, status]);
  return id;
}

beforeAll(async () => {
  for (const [id, name] of [[A, 'EF company A'], [B, 'EF company B']]) {
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [id, name]);
  }
  emp.a1 = await employee(A, 'EF-A1');
  emp.a2 = await employee(A, 'EF-A2');
  emp.a3 = await employee(A, 'EF-A3'); // paid only on the unstamped run
  emp.b1 = await employee(B, 'EF-A1'); // same number, the other company
  // September: final (stamped). a1's parts differ (legacy import shape): a halved total would be R2 214.00 each.
  run.sep = await seedRun(A, 9, 'approved', STAMPED, [
    { employee: emp.a1, gross: 250_000, paye: 80_000, uifEmployee: 1_771.20, uifEmployer: 2_656.80, sdl: 2_500 },
    { employee: emp.a2, gross: 100_000, paye: 25_000, uifEmployee: 1_000, uifEmployer: 1_000, sdl: 1_000 },
  ]);
  // October: approved by status string only, neither stamp. Not final: left out, and named.
  run.oct = await seedRun(A, 10, 'approved', null, [
    { employee: emp.a1, gross: 250_000, paye: 99_990, uifEmployee: 500, uifEmployer: 500, sdl: 2_500 },
    { employee: emp.a3, gross: 40_000, paye: 9_000, uifEmployee: 400, uifEmployer: 400, sdl: 400 },
  ]);
  // November: paid, grandfathered (migration 951 shape). Final.
  run.nov = await seedRun(A, 11, 'paid', GRANDFATHERED, [
    { employee: emp.a2, gross: 100_000, paye: 25_000, uifEmployee: 300, uifEmployer: 700, sdl: 1_000 },
  ]);
  // Company B, September, final, its own split. Never counted for A.
  run.b = await seedRun(B, 9, 'approved', STAMPED, [
    { employee: emp.b1, gross: 500_000, paye: 150_000, uifEmployee: 7_777, uifEmployer: 1_111, sdl: 5_000 },
  ]);
}, 120_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM uif_declarations WHERE company_id = ANY($1::uuid[])', [[A, B]]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id = ANY($1::uuid[])', [Object.values(run)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1::uuid[])', [[A, B]]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1::uuid[])', [[A, B]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
  } finally {
    await pool.end();
  }
});

describe('premise', () => {
  it('finality as payslipFinal judges it: September and November final, October not', async () => {
    expect(await isPayRunFinal(A, run.sep!)).toBe(true);
    expect(await isPayRunFinal(A, run.nov!)).toBe(true);
    expect(await isPayRunFinal(A, run.oct!)).toBe(false);
  });
  it('the readiness card: a3 (paid only on the unstamped run) has no final run; a1 has one', async () => {
    expect((await readEmployeeReadiness(A, emp.a3!))!.hasFinalRun).toBe(false);
    expect((await readEmployeeReadiness(A, emp.a1!))!.hasFinalRun).toBe(true);
  });
});

describe('EMP201: the UIF split is the stored lines\' sums', () => {
  it('September: employee R2 771.20 and employer R3 656.80, not R3 214.00 each', async () => {
    const d = await generateEMP201(A, '2028-09-01', '2028-09-30');
    expect(d.totalUIF).toBe(6_428);
    expect(d.totalUIF_employee).toBe(2_771.2);
    expect(d.totalUIF_employer).toBe(3_656.8);
    expect(d.runWarnings).toEqual([]);
  });
  it('company B\'s run never counts, and B gets its own split', async () => {
    const b = await generateEMP201(B, '2028-09-01', '2028-09-30');
    expect(b.payrollRuns.map((r) => r.id)).toEqual([run.b]);
    expect([b.totalUIF_employee, b.totalUIF_employer]).toEqual([7_777, 1_111]);
  });
});

describe('EMP201: runs by finality', () => {
  it('September to November: the unstamped October run is left out of every figure and named', async () => {
    const d = await generateEMP201(A, '2028-09-01', '2028-11-30');
    expect(d.payrollRuns.map((r) => r.id)).toEqual([run.sep, run.nov]);
    expect(d.totalPAYE).toBe(130_000);
    expect(d.totalUIF).toBe(7_428);
    expect(d.totalUIF_employee).toBe(3_071.2);
    expect(d.totalUIF_employer).toBe(4_356.8);
    expect(d.employeeCount).toBe(2);
    expect(d.runWarnings).toHaveLength(1);
    expect(d.runWarnings[0]).toContain('2028-10');
    expect(d.runWarnings[0]).toContain('not final');
  });
  it('October alone: nothing declared, and the run is still named', async () => {
    const d = await generateEMP201(A, '2028-10-01', '2028-10-31');
    expect(d.payrollRuns).toEqual([]);
    expect(d.totalPAYE).toBe(0);
    expect(d.runWarnings).toHaveLength(1);
  });
});

describe('IRP5: runs by finality', () => {
  it('a1\'s certificate carries September only, never the unstamped October line', async () => {
    const ds = await getIrp5EmployeeTotals(A, TAX_YEAR);
    const a1 = ds.rows.find((r) => r.employeeId === emp.a1)!;
    expect(a1.runsIncluded).toBe(1);
    expect(a1.paye).toBe(80_000);
    expect([a1.uifEmployee, a1.uifEmployer]).toEqual([1_771.2, 2_656.8]);
    const a2 = ds.rows.find((r) => r.employeeId === emp.a2)!;
    expect([a2.runsIncluded, a2.uifEmployee]).toEqual([2, 1_300]);
  });
  it('the unstamped run is named in the warnings, and a3 (paid only on it) is an exclusion that says why', async () => {
    const ds = await getIrp5EmployeeTotals(A, TAX_YEAR);
    expect(ds.warnings.filter((w) => w.includes('2028-10') && w.includes('not final'))).toHaveLength(1);
    expect(ds.rows.map((r) => r.employeeId)).not.toContain(emp.a3);
    const a3 = ds.excluded.find((e) => e.id === emp.a3)!;
    expect(a3.detail).toContain('none of them final');
    expect(a3.amount).toBe(40_000);
    expect(ds.universeTotal).toBe(ds.rowsTotal + ds.excludedTotal);
  });
  it('company B\'s employee with the same number is never on A\'s certificates', async () => {
    const ds = await getIrp5EmployeeTotals(A, TAX_YEAR);
    expect(ds.rows.map((r) => r.employeeId)).not.toContain(emp.b1);
    expect(ds.universeTotal).toBe(3);
  });
});

describe('UI-19: runs by finality', () => {
  it('September declares the final run\'s lines; October (unstamped) declares nothing', async () => {
    const sep = await generateUifDeclaration(A, 2028, 9, USER);
    expect([sep.totalEmployeeContribution, sep.totalEmployerContribution]).toEqual([2_771.2, 3_656.8]);
    const oct = await generateUifDeclaration(A, 2028, 10, USER);
    expect([oct.totalEmployees, oct.totalEmployeeContribution]).toEqual([0, 0]);
    expect((await getUifDeclaration(A, oct.id))!.lines).toEqual([]);
    expect((await getUifDeclaration(A, sep.id))!.lines.map((l) => l.employeeId).sort()).toEqual([emp.a1, emp.a2].sort());
  });
  it('company B\'s September declares only B\'s line', async () => {
    const b = await generateUifDeclaration(B, 2028, 9, USER);
    expect([b.totalEmployees, b.totalEmployeeContribution, b.totalEmployerContribution]).toEqual([1, 7_777, 1_111]);
  });
});
