/**
 * UIF Declaration Service — monthly UI-19 filing.
 * Aggregates payroll run lines for a period and persists totals.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { UI19_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

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
   * The base the run levied UIF on. The run does not store it, so it is
   * recovered: exact when the line is capped (the ceiling) or when the whole
   * gross was leviable; otherwise back-solved from the stored contribution,
   * which is rounded to cents, so it can be up to R0.50 out. 0 contribution
   * (UIF-excluded) shows gross, as before (audit P20).
   */
  leviableSalary: number;
  employeeContribution: number;
  employerContribution: number;
  /** Leviable pay reached the UIF ceiling; read from the stored contribution. */
  isCapped: boolean;
}

export interface UifDeclarationDetail extends UifDeclaration {
  lines: UifDeclarationLine[];
}

/**
 * The UIF ceiling in force for the periods this view serves, and 1% of it.
 * A named constant, not a tax-table lookup, so an old or future period does not
 * need a table to be displayed. Must equal `uifCeiling` in taxTables.ts
 * (tests pin that); revisit with a period-effective value when SARS moves it.
 */
export const UIF_MONTHLY_CEILING = 17_712;
export const UIF_CEILING_CONTRIBUTION = 177.12;

/**
 * Recover a line's UIF base from what the run stored (gross and the rounded
 * employee contribution). Pure; see `UifDeclarationLine.leviableSalary`.
 *
 * Capped = the stored contribution reached the ceiling's and gross is above the
 * ceiling. The one case this cannot tell apart: leviable pay in
 * (R17 711.50, R17 712] on a line whose gross is above the ceiling because of
 * non-UIF earnings, which reads as capped.
 */
export function uifLineBase(
  grossPay: number,
  employeeContribution: number,
): { leviableSalary: number; isCapped: boolean } {
  if (employeeContribution <= 0) return { leviableSalary: grossPay, isCapped: false };
  if (employeeContribution >= UIF_CEILING_CONTRIBUTION && grossPay > UIF_MONTHLY_CEILING) {
    return { leviableSalary: UIF_MONTHLY_CEILING, isCapped: true };
  }
  const grossContribution = Math.round(grossPay * 0.01 * 100) / 100;
  if (grossContribution === employeeContribution) return { leviableSalary: grossPay, isCapped: false };
  return { leviableSalary: Math.round(employeeContribution / 0.01 * 100) / 100, isCapped: false };
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
  // Bound as an array rather than inlined literals so the vocabulary lives in
  // exactly one place (@/lib/constants/payrollRunStatuses).
  const declarableStatuses: string[] = [...UI19_DECLARABLE_STATUSES];

  // Pull per-employee lines from the payroll run for this period
  const lineRows = (await sql`
    SELECT
      prl.employee_id,
      pe.employee_number,
      pe.first_name,
      pe.last_name,
      prl.gross_pay,
      prl.uif_employee,
      prl.uif_employer
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees   pe  ON pe.id  = prl.employee_id
    WHERE prh.company_id = ${companyId}::uuid
      AND prh.period_year  = ${decl.periodYear}
      AND prh.period_month = ${decl.periodMonth}
      AND prh.status = ANY(${declarableStatuses}::text[])
    ORDER BY pe.employee_number
  `) as Row[];

  const lines: UifDeclarationLine[] = lineRows.map(r => {
    const grossPay = Number(r.gross_pay);
    const employeeContribution = Number(r.uif_employee);
    const { leviableSalary, isCapped } = uifLineBase(grossPay, employeeContribution);
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

  return { ...decl, lines };
}

export async function generateUifDeclaration(
  companyId: string,
  year: number,
  month: number,
  generatedByUserId: string,
): Promise<UifDeclaration> {
  log.info('Generating UIF declaration', { companyId, year, month }, 'uifDeclarationService');

  const declarableStatuses: string[] = [...UI19_DECLARABLE_STATUSES];

  // Aggregate from payroll run lines for the period
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
      AND prh.status = ANY(${declarableStatuses}::text[])
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
      'draft', ${generatedByUserId}::uuid, NOW()
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

  return mapUifDeclaration(upsertRows[0]);
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
      submitted_by = ${submittedByUserId}::uuid,
      updated_at   = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];
  if (rows.length === 0 || !rows[0]) return null;
  log.info('UIF declaration marked submitted', { companyId, id }, 'uifDeclarationService');
  return mapUifDeclaration(rows[0]);
}
