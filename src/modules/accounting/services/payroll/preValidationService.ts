/**
 * IRP5/EMP501 pre-validation (wave 6 PV): runs the IRP5 validation engine (`validateEmployeeIrp5`, called, never
 * grown) over the PAYE tax year to date, for every employee with a FINAL line in it, so a missing tax number or a bad
 * ID number is found during the year instead of at the EMP501. Read-only: it writes nothing and blocks nothing.
 *
 * Final is the wave-5 FS rule (`payslipFinal.isPayRunFinal`): `status IN ('approved','paid') AND
 * COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL`, never a status string alone: the one fragment
 * `payRunFinalSql.ts` (wave 6 EF), spliced in `preValidationReads.ts`.
 *
 * Three scopes: the whole tax year; one employee; or one run (its employees, its tax year, and its own lines counted
 * with the final ones, so run approval previews the year as it will stand once the run is approved). Every query
 * carries the company; another company's employee or run is null (404 at the route). What is judged comes from the
 * final lines themselves (`preValidationReads.ts`): totals, the SARS codes paid, the non-cash fringe benefits.
 */
import { sql } from '@/lib/neon';
import { currentPayeTaxYear } from '@/modules/accounting/utils/payeTaxYearToday';
import { payeTaxYearOf } from '@/modules/accounting/utils/payeTaxYear';
import { unflaggedFringeWarning } from '@/modules/accounting/services/payroll/payrollNonCashFiling';
import { loadFinalLineTotals, loadSeveranceDirectives } from '@/modules/accounting/services/payroll/preValidationReads';
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
  /** Only the employees with at least one error or warning, errors first. */
  employees: PreValidationEmployee[];
}

/** `throughMonth` (YYYYMM): only runs up to that month of the tax year (the interim EMP501, wave 6 EFb). */
export type PreValidationScope = { taxYear?: number; employeeId?: string; runId?: string; throughMonth?: number };

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

/**
 * Query count: one read of the scope, one of the final lines (totals, paid codes and fringe together), one of the
 * severance directives, and the SARS code list for the year, which `sarsCodesService` caches per year: every engine
 * lookup after the first is a map read. So it does not grow with the number of employees (pinned by a test).
 */
export async function preValidateTaxYear(companyId: string, scope: PreValidationScope): Promise<PreValidationResult | null> {
  const taxYear = await resolveTaxYear(companyId, scope);
  if (taxYear === null) return null;
  const codeReleaseLoaded = (await listSarsCodes(taxYear)).length > 0;
  const rows = await loadFinalLineTotals(companyId, taxYear, scope.employeeId ?? null, scope.runId ?? null, scope.throughMonth ?? null);
  const severance = await loadSeveranceDirectives(companyId, taxYear, rows.map((r) => r.employee_id));

  const employees: PreValidationEmployee[] = [];
  let errors = 0, warnings = 0;
  for (const row of rows) {
    const name = `${row.first_name} ${row.last_name}`.trim();
    const nonCash = Number(row.non_cash);
    const engine = await validateEmployeeIrp5({
      taxNumber: row.tax_number || null,
      idNumber: row.id_number || null,
      // Remuneration, as the IRP5 summary judges readiness: an employee paid only a non-cash benefit has a certificate.
      totalGross: Number(row.gross) + nonCash,
      totalPaye: Number(row.paye),
      totalUif: Number(row.uif),
      totalSdl: Number(row.sdl),
      componentCodes: row.codes,
      hasApprovedSeveranceDirective: severance.has(row.employee_id),
    }, taxYear);
    const unflagged = Math.round(Number(row.unflagged_3801) * 100) / 100;
    if (unflagged !== 0) {
      engine.push({ severity: 'warning', code: 'IRP5_3801_PAID_IN_CASH', field: 'gross', message: unflaggedFringeWarning(name, unflagged) });
    }
    // Info lines (e.g. "no payroll") are not issues: an employee with only those is not listed or counted.
    const messages = engine.filter((m) => m.severity !== 'info');
    if (messages.length === 0) continue;
    errors += messages.filter((m) => m.severity === 'error').length;
    warnings += messages.filter((m) => m.severity === 'warning').length;
    employees.push({
      employeeId: row.employee_id,
      employeeNumber: String(row.employee_number),
      name,
      severity: highestSeverity(messages),
      issues: messages
        .map((m) => ({ severity: m.severity, code: m.code, message: m.message, field: m.field ?? null, ...fixFor(row.employee_id, m) }))
        .sort((x, y) => RANK[x.severity] - RANK[y.severity]),
    });
  }
  employees.sort((x, y) => RANK[x.severity ?? 'info'] - RANK[y.severity ?? 'info']);
  return { taxYear, employeesChecked: rows.length, errors, warnings, codeReleaseLoaded, employees };
}
