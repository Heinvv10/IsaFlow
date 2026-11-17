/**
 * UIF Declaration Service — monthly UI-19 filing.
 * Aggregates payroll run lines for a period and persists totals.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { contractorLineFlag } from './payrollOutsideTables';
import { payRunFinalSql } from './payRunFinalSql';
import { listNotFinalDeclaredRuns, notFinalRunWarning } from './payRunNotFinal';
import {
  componentIdsToResolve,
  loadComponentTypes,
  parseBreakdown,
  rebuildUifLeviable,
  uifLineBase,
} from './uifLeviableBase';

type Row = DbRow;

export interface UifDeclaration {
  id: string;
  companyId: string;
  periodYear: number;
  periodMonth: number;
  uifReference: string | null;
  totalEmployees: number;
  totalLeviableSalary: number;
  totalEmployeeContribution: number;
  totalEmployerContribution: number;
  totalUif: number;
  status: 'draft' | 'submitted' | 'accepted' | 'paid';
  submittedAt: string | null;
  submittedBy: string | null;
  notes: string | null;
  journalEntryId: string | null;
  paymentDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** Approved/paid runs of the month left out because they are not final (wave 6 EF), by name; set by generate and get. */
  runWarnings?: string[];
}

export interface UifPaymentResult {
  id: string;
  totalPaid: number;
  journalEntryId: string;
  status: 'paid';
}

export interface UifDeclarationLine {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  /**
   * The base the run levied UIF on (capped at the ceiling). The run does not
   * store it, so it is rebuilt from the line's component breakdown (exact, see
   * uifLeviableBase.ts). Only when that cannot be done is it derived from the
   * stored contribution: exact at the ceiling or when all of gross was
   * leviable, otherwise up to R0.50 out. A UIF-excluded employee (nothing
   * stored) shows gross (audit P20).
   */
  leviableSalary: number;
  employeeContribution: number;
  employerContribution: number;
  /** Leviable pay is above the UIF ceiling (the contribution is capped). */
  isCapped: boolean;
}

export interface UifDeclarationDetail extends UifDeclaration {
  lines: UifDeclarationLine[];
}

/** Exported for `uifPaymentService`, which was split out of this file. */
export function mapUifDeclaration(r: Row): UifDeclaration {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    periodYear: Number(r.period_year),
    periodMonth: Number(r.period_month),
    uifReference: r.uif_reference ? String(r.uif_reference) : null,
    totalEmployees: Number(r.total_employees),
    totalLeviableSalary: Number(r.total_leviable_salary),
    totalEmployeeContribution: Number(r.total_employee_contribution),
    totalEmployerContribution: Number(r.total_employer_contribution),
    totalUif: Number(r.total_employee_contribution) + Number(r.total_employer_contribution),
    status: String(r.status) as UifDeclaration['status'],
    submittedAt: r.submitted_at
      ? (r.submitted_at instanceof Date ? r.submitted_at.toISOString() : String(r.submitted_at))
      : null,
    submittedBy: r.submitted_by ? String(r.submitted_by) : null,
    notes: r.notes ? String(r.notes) : null,
    journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
    paymentDate: r.payment_date ? fmtDate(r.payment_date) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function listUifDeclarations(
  companyId: string,
  filters: { year?: number } = {},
): Promise<UifDeclaration[]> {
  const rows = (await sql`
    SELECT *
    FROM uif_declarations
    WHERE company_id = ${companyId}::uuid
      AND (${filters.year ?? null}::int IS NULL OR period_year = ${filters.year ?? null})
    ORDER BY period_year DESC, period_month DESC
  `) as Row[];
  return rows.map(mapUifDeclaration);
}

/** The month's approved/paid runs that are not final, named as the EMP201 and IRP5 name them (wave 6 EF). */
async function uifRunWarnings(companyId: string, year: number, month: number): Promise<string[]> {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  return (await listNotFinalDeclaredRuns(companyId, first, first)).map((r) => notFinalRunWarning(r, 'UI-19'));
}

export async function getUifDeclaration(
  companyId: string,
  id: string,
): Promise<UifDeclarationDetail | null> {
  const rows = (await sql`
    SELECT * FROM uif_declarations
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (rows.length === 0 || !rows[0]) return null;

  const decl = mapUifDeclaration(rows[0]);

  // Pull per-employee lines from the payroll run for this period
  const lineRows = (await sql`
    SELECT
      prl.employee_id,
      pe.employee_number,
      pe.first_name,
      pe.last_name,
      prl.gross_pay,
      prl.uif_employee,
      prl.uif_employer,
      prl.component_breakdown
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees   pe  ON pe.id  = prl.employee_id
    WHERE prh.company_id = ${companyId}::uuid
      AND prh.period_year  = ${decl.periodYear}
      AND prh.period_month = ${decl.periodMonth}
      -- Final runs only (payRunFinalSql: approved or paid with an approval time), as the EMP201.
      AND ${sql.unsafe(payRunFinalSql('prh'))}
      -- An independent contractor is no UIF contributor (G21 p. 26): not on the UI-19.
      AND NOT COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)
    ORDER BY pe.employee_number
  `) as Row[];

  const breakdowns = lineRows.map((r) => parseBreakdown(r.component_breakdown));
  const types = await loadComponentTypes(
    companyId,
    [...new Set(breakdowns.flatMap((b) => (b ? componentIdsToResolve(b) : [])))],
  );

  const lines: UifDeclarationLine[] = lineRows.map((r, i) => {
    const grossPay = Number(r.gross_pay);
    const employeeContribution = Number(r.uif_employee);
    const items = breakdowns[i];
    const { leviableSalary, isCapped } = uifLineBase(
      grossPay,
      employeeContribution,
      items ? rebuildUifLeviable(items, types) : null,
    );
    return {
      employeeId: String(r.employee_id),
      employeeNumber: String(r.employee_number),
      employeeName: `${r.first_name} ${r.last_name}`,
      grossPay,
      leviableSalary,
      employeeContribution,
      employerContribution: Number(r.uif_employer),
      isCapped,
    };
  });

  return { ...decl, lines, runWarnings: await uifRunWarnings(companyId, decl.periodYear, decl.periodMonth) };
}

export async function generateUifDeclaration(
  companyId: string,
  year: number,
  month: number,
  generatedByUserId: string,
): Promise<UifDeclaration> {
  log.info('Generating UIF declaration', { companyId, year, month }, 'uifDeclarationService');

  // Aggregate from the final runs' lines for the period (payRunFinalSql, as the EMP201)
  const aggRows = (await sql`
    SELECT
      COUNT(DISTINCT prl.employee_id)::int        AS employee_count,
      COALESCE(SUM(prl.uif_employee), 0)::numeric AS total_uif_employee,
      COALESCE(SUM(prl.uif_employer), 0)::numeric AS total_uif_employer
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    WHERE prh.company_id  = ${companyId}::uuid
      AND prh.period_year  = ${year}
      AND prh.period_month = ${month}
      AND ${sql.unsafe(payRunFinalSql('prh'))}
      AND NOT COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)
  `) as Row[];

  const agg = aggRows[0];
  if (!agg) throw new Error('Aggregation query returned no row');

  const totalUifEmployee = Number(agg.total_uif_employee);
  const totalUifEmployer = Number(agg.total_uif_employer);
  const employeeCount = Number(agg.employee_count);

  // Leviable salary = employee contribution / 0.01
  // (stored uif_employee already reflects the ceiling cap applied at run time)
  const totalLeviable = totalUifEmployee > 0 ? totalUifEmployee / 0.01 : 0;

  const r = (n: number) => Math.round(n * 100) / 100;

  const upsertRows = (await sql`
    INSERT INTO uif_declarations (
      company_id, period_year, period_month,
      total_employees, total_leviable_salary,
      total_employee_contribution, total_employer_contribution,
      status, submitted_by, updated_at
    ) VALUES (
      ${companyId}::uuid, ${year}, ${month},
      ${employeeCount}, ${r(totalLeviable)},
      ${r(totalUifEmployee)}, ${r(totalUifEmployer)},
      'draft', ${generatedByUserId}, NOW()
    )
    ON CONFLICT (company_id, period_year, period_month) DO UPDATE SET
      total_employees             = EXCLUDED.total_employees,
      total_leviable_salary       = EXCLUDED.total_leviable_salary,
      total_employee_contribution = EXCLUDED.total_employee_contribution,
      total_employer_contribution = EXCLUDED.total_employer_contribution,
      status = CASE
        WHEN uif_declarations.status = 'draft' THEN 'draft'
        ELSE uif_declarations.status
      END,
      updated_at = NOW()
    RETURNING *
  `) as Row[];

  if (!upsertRows[0]) throw new Error('Upsert returned no row');

  log.info(
    'UIF declaration generated',
    { companyId, year, month, employeeCount, totalLeviable },
    'uifDeclarationService',
  );

  return { ...mapUifDeclaration(upsertRows[0]), runWarnings: await uifRunWarnings(companyId, year, month) };
}

export async function markUifSubmitted(
  companyId: string,
  id: string,
  submittedByUserId: string,
): Promise<UifDeclaration | null> {
  const rows = (await sql`
    UPDATE uif_declarations SET
      status       = 'submitted',
      submitted_at = NOW(),
      submitted_by = ${submittedByUserId},
      updated_at   = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];
  if (rows.length === 0 || !rows[0]) return null;
  log.info('UIF declaration marked submitted', { companyId, id }, 'uifDeclarationService');
  return mapUifDeclaration(rows[0]);
}
