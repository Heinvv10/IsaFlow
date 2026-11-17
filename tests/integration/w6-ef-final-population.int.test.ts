/**
 * Wave 6 EF, review round 1 (the ledger breaker's repros, ported): every form reached through the EMP201, IRP5 and
 * UI-19 counts the SAME runs, the final ones (payRunFinalSql). An `approved` run with neither stamp is left out of
 * the main totals, so the ETI carry, the EMP201 drill, the certificate's sub-readers (allowances, fringe benefits,
 * 4582, lump sums, medical, retirement), the UI-19 warning and the EMP201 drift must leave it out (or name it) too.
 * One company; amounts ten times a month; pay months September to November 2028 (tax year 2029).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { emp201FieldDrill } from '@/modules/accounting/services/reports/emp201FieldDrill';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { generateUifDeclaration } from '@/modules/accounting/services/payroll/uifDeclarationService';
import { empRunDrift } from '@/modules/accounting/services/returns/empDrift';
import { loadCertificateAggregates } from '@/modules/accounting/services/payroll/easyFileCertificateAggregates';
import { listRunAllowanceFiling } from '@/modules/accounting/services/payroll/payrollAllowanceFiling';
import { listRunAnnualPayments, listRunLumpSums } from '@/modules/accounting/services/payroll/payrollLumpSumFiling';
import { loadMedicalRecord } from '@/modules/accounting/services/payroll/payrollMedicalRecord';
import { loadRetirementContributions } from '@/modules/accounting/services/payroll/payrollRetirementRecord';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const C = crypto.randomUUID();
const USER = crypto.randomUUID();
const emp: Record<string, string> = {};
const run: Record<string, string> = {};
const DIRECTIVE = crypto.randomUUID();
const YEAR = { start: '2028-03-01', end: '2029-02-28' };

async function employee(number: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, $2, 'Br', $2, '2020-01-01') RETURNING id::text AS id`, [C, number])).rows[0]!.id;
}

async function seedRun(month: number, stamp: string | null, l: {
  employee: string; gross: number; paye: number; eti: number; uif: number; breakdown?: unknown[];
}): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, employee_count,
       total_gross, total_paye, total_uif, total_sdl, total_eti, total_net)
     VALUES ($1, $2, 2028, 'calculated', 1, $3, $4, $5, 0, $6, $3::numeric - $4::numeric) RETURNING id::text AS id`,
    [C, month, l.gross, l.paye, l.uif * 2, l.eti])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, eti, net_pay, component_breakdown)
     VALUES ($1, $2, $3, $3, $4, $5, $5, 0, $6, $3::numeric - $4::numeric, $7::jsonb)`,
    [id, l.employee, l.gross, l.paye, l.uif, l.eti, JSON.stringify(l.breakdown ?? [])]);
  await pool.query(`UPDATE payroll_run_headers SET status = 'approved'${stamp ? `, ${stamp}` : ''} WHERE id = $1`, [id]);
  return id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [C, 'Breaker 1490']);
  emp.x = await employee('BR-X');
  run.sep = await seedRun(9, 'approved_at = clock_timestamp()', { employee: emp.x, gross: 30_000, paye: 5_000, eti: 0, uif: 177.12 });
  await pool.query(
    `INSERT INTO tax_directives (id, company_id, employee_id, employee_name, directive_number, directive_type, amount, tax_rate, effective_date, status)
     VALUES ($1, $2, $3, 'Br X', '9876543210', 'severance', 50000, 0, '2028-10-01', 'approved')`, [DIRECTIVE, C, emp.x]);
  // October: approved, NO stamp. ETI above PAYE (carry 4 000); on the line a cash 3701, a non-cash 3802, a 3605 annual
  // payment, an in-run directive lump sum (3901), a pension contribution (4001) and medical scheme fees: every
  // certificate sub-reader has something to (wrongly) pick up from it.
  run.oct = await seedRun(10, null, {
    employee: emp.x, gross: 30_000, paye: 1_000, eti: 5_000, uif: 177.12,
    breakdown: [
      { sarsSourceCode: '3701', amount: 8_000, isTaxable: true, payeIncludedAmount: 6_400 },
      { sarsSourceCode: '3802', amount: 2_000, isNonCash: true, isTaxable: true, payeIncludedAmount: 1_600 },
      { sarsSourceCode: '3605', amount: 4_000, isTaxable: true },
      { sarsSourceCode: '3901', amount: 5_000, isTaxable: true, directive: { id: DIRECTIVE, number: '9876543210', paye: 500 } },
      { sarsSourceCode: '4001', amount: 2_000, isTaxable: true, retirementContribution: true },
    ],
  });
  await pool.query(
    `UPDATE payroll_run_lines SET medical_scheme_fees = 3000, retirement_contributions = 2000, retirement_deduction = 2000 WHERE run_id = $1`,
    [run.oct]);
  run.nov = await seedRun(11, 'approved_at = clock_timestamp()', { employee: emp.x, gross: 30_000, paye: 5_000, eti: 0, uif: 177.12 });
}, 120_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM uif_declarations WHERE company_id = $1', [C]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id = ANY($1::uuid[])', [Object.values(run)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [C]);
    await pool.query('DELETE FROM tax_directives WHERE company_id = $1', [C]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [C]);
    await pool.query('DELETE FROM companies WHERE id = $1', [C]);
  } finally {
    await pool.end();
  }
});

describe('one final-run population across the EMP201, IRP5 and UI-19', () => {
  it('A1 ETI: November\'s EMP201 must not use ETI carried from the October run its own October EMP201 left out', async () => {
    const oct = await generateEMP201(C, '2028-10-01', '2028-10-31');
    expect(oct.payrollRuns).toEqual([]);           // October declared nothing
    const nov = await generateEMP201(C, '2028-11-01', '2028-11-30');
    expect(nov.etiCarry.broughtForward).toBe(0);   // was 4 000, carried from the undeclared October run
    expect(nov.payePayable).toBe(5_000);           // was 1 000 (PAYE under-declared by R4 000)
  });

  it('A2 drill: the EMP201 PAYE drill ties to the EMP201 it drills', async () => {
    const d = await generateEMP201(C, '2028-09-01', '2028-11-30');
    const drill = (await emp201FieldDrill(C, '2028-09-01', '2028-11-30', 'paye'))!;
    expect(drill.total).toBe(d.totalPAYE);          // was 11 000 against 10 000
  });

  it('A3 IRP5: the certificate\'s allowance/fringe fields come from the same runs as its gross and PAYE', async () => {
    const ds = await getIrp5EmployeeTotals(C, 2029);
    const x = ds.rows.find((r) => r.employeeId === emp.x)!;
    expect(x.runsIncluded).toBe(2);
    expect(x.paye).toBe(10_000);
    expect(x.cashAllowances).toEqual([]);           // was [{3701, 8000}] from the unstamped October line
    expect(x.fringeBenefits).toEqual([]);           // was [{3802, 2000}]
    expect(x.paye4582).toBeNull();                  // was a 4582 from October
  });

  it('A4 UI-19: the October declaration names the run it leaves out, as the EMP201 and IRP5 do', async () => {
    const oct = await generateUifDeclaration(C, 2028, 10, USER);
    expect(oct.totalEmployeeContribution).toBe(0);
    expect(oct.runWarnings).toHaveLength(1);
    expect(oct.runWarnings![0]).toContain('2028-10');
    expect(oct.runWarnings![0]).toContain('not on this UI-19');
    const sep = await generateUifDeclaration(C, 2028, 9, USER);
    expect(sep.runWarnings).toEqual([]);
  });

  it('A5 drift: an approved run of the period with no approval time counts as unfinal (L5)', async () => {
    const oct = await generateEMP201(C, '2028-10-01', '2028-10-31');
    expect((await empRunDrift(C, { runs: [] }, oct)).unfinalRuns).toBe(1);
    const sep = await generateEMP201(C, '2028-09-01', '2028-09-30');
    expect((await empRunDrift(C, { runs: sep.payrollRuns.map((r) => ({ id: r.id, approvedPlanHash: null })) }, sep)).unfinalRuns).toBe(0);
  });

  it('B1 e@syFile: the certificate aggregate (3601, 4102) counts the same final runs as its sub-readers', async () => {
    const agg = (await loadCertificateAggregates(C, { startYear: 2028, startMonth: 3, endYear: 2029, endMonth: 2 }))
      .find((r) => String(r.employee_id) === emp.x)!;
    expect((await listRunAllowanceFiling(C, YEAR)).get(emp.x)).toBeUndefined();
    expect(Number(agg.total_gross)).toBe(60_000);   // was 90 000: October's gross with its 3701 inside it
    expect(Number(agg.total_paye)).toBe(10_000);    // was 11 000
  });

  it('M3 sub-readers: the unstamped October line\'s 3605, 3901 lump sum, medical fees and pension are on no certificate', async () => {
    expect((await listRunAnnualPayments(C, YEAR)).get(emp.x)).toBeUndefined();
    expect((await listRunLumpSums(C, YEAR)).get(emp.x)).toBeUndefined();
    expect((await loadMedicalRecord(C, YEAR)).get(emp.x)?.fees ?? 0).toBe(0);
    const ret = (await loadRetirementContributions(C, YEAR)).get(emp.x);
    expect(ret?.pension4001 ?? 0).toBe(0);
  });
});
