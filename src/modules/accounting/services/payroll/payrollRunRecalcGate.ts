/**
 * Approval refusals that say "recalculate this run" or "fix the leaver first" (payroll breaker round, Hein 2026-11-02).
 * Read-only; used by the approval gate (payrollApprovalGate.judgePayrollApproval).
 *   - recalculate_required: the run carries no calculation stamp (calculated before migration 953) or an older one
 *     than PAYROLL_CALCULATION_VERSION: its lines were read under other rules.
 *   - components_changed_after_calculation: an employee on the run had an assignment's dates changed (Edit dates,
 *     End, cancel, the pay-run grid: audit_log entity payroll_employee_component; a removal by its metadata) after calculation.
 *   - employment_terms_unresolved: a line carries EMPLOYMENT_UNDETERMINED (the terms of work cannot classify the employment, G21 p. 28)
 *     or DIRECTOR_STATUS_NOT_SET (employment type director, tax status employee) as an error (validationEngine.validateEmploymentTerms).
 *   - termination_base_missing: a leaver's line carries TERMINATION_BASE_MISSING as an error (a termination reason,
 *     no recurring earnings on the end date, and a pay-out that needs that base). As a warning it does not refuse.
 * Both run on every approval, also a re-approval onto a journal still in force. The changed check covers the run's
 * lines and its population now (listPayrollRunEmployees), so a hire with pay added after calculation counts.
 * IsaFlow has no per-employee hold, so each refuses the whole run, naming the employees.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PAYROLL_CALCULATION_VERSION } from './payrollCalculationVersion';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { EMPLOYMENT_TERMS_BLOCKING_CODES } from './validationEngine';
import { payrollTermsChangedSinceCalculation } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import type { PayrollJournalNote } from './payrollJournalBuilder';

export const TERMINATION_BASE_MISSING = 'TERMINATION_BASE_MISSING';
const blockingTermsPath = `$[*] ? (@.severity == "error" && (${EMPLOYMENT_TERMS_BLOCKING_CODES.map((c) => `@.code == "${c}"`).join(' || ')}))`;

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
      + '(components read on the 27th, short once-offs, termination base, which deductions reduce PAYE). Recalculate this run, then approve it.',
  };
}

/** Component dates changed after calculation, or a leaver with no termination base. Null when neither. */
export async function runLinesRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const head = ((await sql`
    SELECT period_year, period_month FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!head) return null;
  // The run's lines AND everyone the run would pay now: a hire with pay added after calculation has no line yet.
  const lineIds = ((await sql`SELECT employee_id FROM payroll_run_lines WHERE run_id = ${runId}::uuid`) as DbRow[])
    .map((r) => String(r.employee_id));
  const population = await listPayrollRunEmployees(companyId, { year: Number(head.period_year), month: Number(head.period_month) });
  const ids = [...new Set([...lineIds, ...population.map((e) => e.id)])];
  const changed = (await sql`
    SELECT DISTINCT e.employee_number
    FROM payroll_run_headers h
    JOIN audit_log a ON a.company_id = h.company_id AND a.entity_type = 'payroll_employee_component'
    -- A removed row (action 'delete', the pay-run grid) is gone: its employee is in the audit row's metadata.
    LEFT JOIN payroll_employee_components pec ON pec.id = a.entity_id
    JOIN payroll_employees e ON e.company_id = h.company_id
      AND e.id = COALESCE(pec.employee_id, CASE WHEN a.action = 'delete' THEN (a.changes->'metadata'->>'employeeId')::uuid END)
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND e.id = ANY(${ids}::uuid[])
      AND a.created_at > h.calculated_at
    ORDER BY 1
  `) as DbRow[];
  // An end date or termination detail changed after calculation (the 888 entity history): it moves who the run pays,
  // what the termination pay-outs and the leaver rule read. Unreadable history fails closed.
  const movedEnd = await payrollTermsChangedSinceCalculation(companyId, runId, ids);
  if (movedEnd === null) {
    return {
      code: 'employee_history_unreadable',
      detail: 'Approving this run checks the employees\' change history (end dates, termination details) since it was '
        + 'calculated, and your role cannot read it. Ask an owner, admin or manager to approve the run.',
    };
  }
  if (movedEnd.length > 0) {
    changed.push(...((await sql`
      SELECT employee_number FROM payroll_employees WHERE company_id = ${companyId}::uuid AND id = ANY(${movedEnd}::uuid[])
    `) as DbRow[]));
  }
  if (changed.length > 0) {
    return {
      code: 'components_changed_after_calculation',
      detail: `Pay component dates, an end date, termination details, an s18A receipt tick or the work terms (tax status, pay basis, hours, rates) changed after this run was calculated for ${[...new Set(changed.map((r) => String(r.employee_number)))].sort().join(', ')}: `
        + 'the run still holds the old figures. Recalculate this run, then approve it.',
    };
  }
  const baseless = (await sql`
    SELECT e.employee_number
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND jsonb_path_exists(l.validation_results, ${`$[*] ? (@.code == "${TERMINATION_BASE_MISSING}" && @.severity == "error")`}::jsonpath)
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
  const unresolved = (await sql`
    SELECT DISTINCT e.employee_number
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND jsonb_path_exists(l.validation_results, ${blockingTermsPath}::jsonpath)
    ORDER BY 1
  `) as DbRow[];
  if (unresolved.length > 0) {
    return {
      code: 'employment_terms_unresolved',
      detail: `${unresolved.map((r) => String(r.employee_number)).join(', ')}: the terms of work do not say how the employee is taxed `
        + '(hours or pay for a day missing for a part-time employee, or employment type Director with tax status Employee). '
        + 'Fix the employee\'s work terms, then recalculate the run.',
    };
  }
  return null;
}
