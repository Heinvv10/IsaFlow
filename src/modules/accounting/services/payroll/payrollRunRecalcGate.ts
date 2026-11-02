/**
 * Approval refusals that say "recalculate this run" or "fix the leaver first" (payroll breaker round, Hein 2026-11-02).
 * Read-only; used by the approval gate (payrollApprovalGate.judgePayrollApproval).
 *   - recalculate_required: the run carries no calculation stamp (calculated before migration 953) or an older one
 *     than PAYROLL_CALCULATION_VERSION: its lines were read under other rules.
 *   - components_changed_after_calculation: an employee on the run had an assignment's dates changed (Edit dates,
 *     End, cancel: audit_log entity payroll_employee_component) after the run was calculated.
 *   - termination_base_missing: a leaver's line carries TERMINATION_BASE_MISSING (a termination reason and no
 *     recurring earnings on the end date, so leave and notice pay have no base).
 * IsaFlow has no per-employee hold, so each refuses the whole run, naming the employees.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PAYROLL_CALCULATION_VERSION } from './payrollCalculationVersion';
import type { PayrollJournalNote } from './payrollJournalBuilder';

export const TERMINATION_BASE_MISSING = 'TERMINATION_BASE_MISSING';

/** Whether the run was calculated by this calculation version. Applies to every approval. */
export async function recalculateRequiredRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const rows = (await sql`
    SELECT calculation_version FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  const version = rows[0]?.calculation_version;
  if (!rows[0] || (version != null && Number(version) >= PAYROLL_CALCULATION_VERSION)) return null;
  return {
    code: 'recalculate_required',
    detail: 'This run was calculated by an earlier version of the payroll calculation, whose figures may differ '
      + '(components read on the 27th, short once-offs, termination base). Recalculate this run, then approve it.',
  };
}

/** Component dates changed after calculation, or a leaver with no termination base. Null when neither. */
export async function runLinesRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const changed = (await sql`
    SELECT DISTINCT e.employee_number
    FROM payroll_run_headers h
    JOIN payroll_run_lines l ON l.run_id = h.id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    JOIN payroll_employee_components pec ON pec.employee_id = l.employee_id
    JOIN audit_log a ON a.entity_id = pec.id AND a.company_id = h.company_id
                    AND a.entity_type = 'payroll_employee_component'
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND a.created_at > h.calculated_at
    ORDER BY 1
  `) as DbRow[];
  if (changed.length > 0) {
    return {
      code: 'components_changed_after_calculation',
      detail: `Pay component dates changed after this run was calculated for ${changed.map((r) => String(r.employee_number)).join(', ')}: `
        + 'the run still holds the old figures. Recalculate this run, then approve it.',
    };
  }
  const baseless = (await sql`
    SELECT e.employee_number
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND jsonb_path_exists(l.validation_results, ${`$[*] ? (@.code == "${TERMINATION_BASE_MISSING}")`}::jsonpath)
    ORDER BY 1
  `) as DbRow[];
  if (baseless.length > 0) {
    return {
      code: 'termination_base_missing',
      detail: `${baseless.map((r) => String(r.employee_number)).join(', ')}: a termination reason is captured but there are no recurring `
        + 'earnings on the end date, so leave and notice pay have no base. Correct the pay components (or the end date) '
        + 'and recalculate.',
    };
  }
  return null;
}
