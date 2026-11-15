/**
 * IRP5/EMP501 pre-validation (wave 6 PV): runs the IRP5 validation engine (`validateEmployeeIrp5`, called, never
 * grown) over the PAYE tax year to date, for every employee with a FINAL line in it, so a missing tax number or a bad
 * ID number is found during the year instead of at the EMP501. Read-only: it writes nothing and blocks nothing.
 *
 * Final is the wave-5 FS rule (`payslipFinal.isPayRunFinal`): `status IN ('approved','paid') AND
 * COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL`, never a status string alone. Inlined here until
 * EF's single fragment (`payRunFinalSql.ts`) lands; EF owns the IRP5 and EMP201 services this wave.
 *
 * Three scopes: the whole tax year; one employee; or one run (its employees, its tax year, and its own lines counted
 * with the final ones, so run approval previews the year as it will stand once the run is approved). Every query
 * carries the company; another company's employee or run is null (404 at the route).
 */
import { sql } from '@/lib/neon';
import { currentPayeTaxYear } from '@/modules/accounting/utils/payeTaxYearToday';
import { payeTaxYearBounds, payeTaxYearOf, payeTaxYearPeriods } from '@/modules/accounting/utils/payeTaxYear';
import { listSarsCodes } from '@/modules/accounting/services/payroll/sarsCodesService';
import {
  highestSeverity, validateEmployeeIrp5, type ValidationMessage, type ValidationSeverity,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';

export interface PreValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  field: string | null;
  /** Where the user fixes it: the profile field, the pay components, or the tax directives. */
  fixHref: string;
  fixLabel: string;
}

export interface PreValidationEmployee {
  employeeId: string;
  employeeNumber: string;
  name: string;
  severity: ValidationSeverity | null;
  issues: PreValidationIssue[];
}

export interface PreValidationResult {
  taxYear: number;
  /** Employees with a final line in the tax year (or on the run) that the engine checked. */
  employeesChecked: number;
  errors: number;
  warnings: number;
  /**
   * Whether a SARS source-code release is loaded for this tax year. The engine looks codes up by exact year, so with
   * none every component code reads as unknown: the screens say so rather than present those errors as the truth.
   */
  codeReleaseLoaded: boolean;
  /** Only the employees with at least one issue, errors first. */
  employees: PreValidationEmployee[];
}

export type PreValidationScope = { taxYear?: number; employeeId?: string; runId?: string };

type AggRow = {
  employee_id: string; employee_number: string; first_name: string; last_name: string;
  tax_number: string | null; id_number: string | null; gross: string; paye: string; uif: string; sdl: string;
};

export function fixFor(employeeId: string, m: ValidationMessage): { fixHref: string; fixLabel: string } {
  const profile = `/payroll/employees/${employeeId}`;
  if (m.field === 'tax_number') return { fixHref: `${profile}#employee-tax-number`, fixLabel: 'Tax number' };
  if (m.field === 'id_number') return { fixHref: `${profile}#employee-id-number`, fixLabel: 'ID number' };
  if (m.code === 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE') return { fixHref: '/payroll/tax-directives', fixLabel: 'Tax directives' };
  return { fixHref: `${profile}#employee-pay`, fixLabel: 'Pay components' };
}

const RANK: Record<ValidationSeverity, number> = { error: 0, warning: 1, info: 2 };

/** The scope's tax year, or null when its employee or run is not this company's. */
async function resolveTaxYear(companyId: string, scope: PreValidationScope): Promise<number | null> {
  if (scope.runId) {
    const run = (await sql`
      SELECT period_month, period_year FROM payroll_run_headers
       WHERE id = ${scope.runId}::uuid AND company_id = ${companyId}::uuid`) as Array<{ period_month: number; period_year: number }>;
    return run[0] ? payeTaxYearOf(Number(run[0].period_month), Number(run[0].period_year)) : null;
  }
  if (scope.employeeId) {
    const emp = await sql`
      SELECT 1 FROM payroll_employees WHERE id = ${scope.employeeId}::uuid AND company_id = ${companyId}::uuid`;
    if (emp.length === 0) return null;
  }
  return scope.taxYear ?? currentPayeTaxYear();
}

export async function preValidateTaxYear(companyId: string, scope: PreValidationScope): Promise<PreValidationResult | null> {
  const taxYear = await resolveTaxYear(companyId, scope);
  if (taxYear === null) return null;
  const p = payeTaxYearPeriods(taxYear);
  const bounds = payeTaxYearBounds(taxYear);
  const runId = scope.runId ?? null;
  const employeeId = scope.employeeId ?? null;

  const rows = (await sql`
    SELECT prl.employee_id::text AS employee_id, pe.employee_number, pe.first_name, pe.last_name, pe.tax_number, pe.id_number,
           SUM(prl.gross_pay) AS gross, SUM(prl.paye) AS paye,
           SUM(prl.uif_employee + prl.uif_employer) AS uif, SUM(prl.sdl) AS sdl
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
      JOIN payroll_employees pe ON pe.id = prl.employee_id
     WHERE prh.company_id = ${companyId}::uuid
       AND pe.company_id = ${companyId}::uuid
       AND ((prh.status IN ('approved', 'paid') AND COALESCE(prh.approved_at, prh.approval_grandfathered_at) IS NOT NULL)
            OR prh.id = ${runId}::uuid)
       AND ((prh.period_year = ${p.startYear} AND prh.period_month >= ${p.startMonth})
            OR (prh.period_year = ${p.endYear} AND prh.period_month <= ${p.endMonth}))
       AND (${employeeId}::uuid IS NULL OR prl.employee_id = ${employeeId}::uuid)
       AND (${runId}::uuid IS NULL OR prl.employee_id IN (SELECT employee_id FROM payroll_run_lines WHERE run_id = ${runId}::uuid))
     GROUP BY prl.employee_id, pe.employee_number, pe.first_name, pe.last_name, pe.tax_number, pe.id_number
     ORDER BY pe.last_name, pe.first_name, pe.employee_number
  `) as AggRow[];
  const employeeIds = rows.map((r) => r.employee_id);

  const [codeRows, directiveRows] = employeeIds.length === 0 ? [[], []] : await Promise.all([
    sql`
      SELECT DISTINCT pec.employee_id::text AS employee_id, pc.sars_source_code
        FROM payroll_employee_components pec
        JOIN payroll_components pc ON pc.id = pec.component_id
        JOIN payroll_employees pe ON pe.id = pec.employee_id
       WHERE pe.company_id = ${companyId}::uuid AND pc.company_id = ${companyId}::uuid
         AND pec.employee_id = ANY(${employeeIds}::uuid[])
         AND pc.is_active = TRUE
         AND (pec.effective_to IS NULL OR pec.effective_to >= CURRENT_DATE)
    ` as Promise<Array<{ employee_id: string; sars_source_code: string }>>,
    sql`
      SELECT DISTINCT employee_id::text AS employee_id FROM tax_directives
       WHERE company_id = ${companyId}::uuid AND directive_type = 'severance' AND status = 'approved'
         AND employee_id = ANY(${employeeIds}::uuid[])
         AND effective_date <= ${bounds.end}::date AND (expiry_date IS NULL OR expiry_date >= ${bounds.start}::date)
    ` as Promise<Array<{ employee_id: string }>>,
  ]);
  const codes = new Map<string, string[]>();
  for (const c of codeRows) codes.set(c.employee_id, [...(codes.get(c.employee_id) ?? []), String(c.sars_source_code)]);
  const severance = new Set(directiveRows.map((d) => d.employee_id));

  const employees: PreValidationEmployee[] = [];
  let errors = 0, warnings = 0;
  for (const row of rows) {
    const messages = await validateEmployeeIrp5({
      taxNumber: row.tax_number || null,
      idNumber: row.id_number || null,
      totalGross: Number(row.gross),
      totalPaye: Number(row.paye),
      totalUif: Number(row.uif),
      totalSdl: Number(row.sdl),
      componentCodes: codes.get(row.employee_id) ?? [],
      hasApprovedSeveranceDirective: severance.has(row.employee_id),
    }, taxYear);
    if (messages.length === 0) continue;
    errors += messages.filter((m) => m.severity === 'error').length;
    warnings += messages.filter((m) => m.severity === 'warning').length;
    employees.push({
      employeeId: row.employee_id,
      employeeNumber: String(row.employee_number),
      name: `${row.first_name} ${row.last_name}`.trim(),
      severity: highestSeverity(messages),
      issues: messages
        .map((m) => ({ severity: m.severity, code: m.code, message: m.message, field: m.field ?? null, ...fixFor(row.employee_id, m) }))
        .sort((a, b) => RANK[a.severity] - RANK[b.severity]),
    });
  }
  employees.sort((a, b) => RANK[a.severity ?? 'info'] - RANK[b.severity ?? 'info']);
  const codeReleaseLoaded = (await listSarsCodes(taxYear)).length > 0;
  return { taxYear, employeesChecked: rows.length, errors, warnings, codeReleaseLoaded, employees };
}
