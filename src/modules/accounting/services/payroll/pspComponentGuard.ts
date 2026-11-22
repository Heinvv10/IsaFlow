/**
 * A personal service provider may not carry a retirement fund contribution, an s18A donation, a fringe benefit or a loan
 * (pspLineRules.pspRefusedKind; wave 6 PSP, review of #1566 M3/M4). Refused, naming the employee and the components, with
 * PspComponentRefused (409) before any write: at assignment (refuseAssignmentWrite, every writer that inserts one) and at
 * calculate (calculatePayrollRun, before loans are applied), which also catches a status moved to PSP after the
 * assignment. Every read is scoped by company_id.
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { sql } from '@/lib/neon';
import { IRP3C_MARKER, PspComponentRefused, PspStatusChangedSinceApproval, pspRefusalMessage, pspRefusedKind, type PspRefusedKind } from './pspLineRules';
import { pspLineFlag } from './payrollOutsideTables';
import { payrollRunReadDate } from './payrollRunReadDate';
import type { PayrollPeriod } from './payrollTypes';

const PSP = 'personal_service_provider';

/**
 * The days a run pays (review of #1566, merge L1): a weekly or fortnightly run's own dates (FQc, runPeriodOf), else the
 * calendar month, ending on the run's read date (payrollRunReadDate). A component live only outside them is not on it.
 */
export function pspGuardWindow(period: PayrollPeriod): { start: string; end: string } {
  return { start: period.start ?? `${period.year}-${String(period.month).padStart(2, '0')}-01`, end: payrollRunReadDate(period) };
}

/** Assignment: the employee is a PSP and the component is one a PSP cannot carry. */
export async function refusePspAssignment(tx: TxSql, companyId: string, employeeId: string, componentId: string): Promise<void> {
  const rows = (await tx`
    SELECT e.employee_number, c.name, c.sars_source_code, c.component_type
      FROM payroll_employees e
      JOIN payroll_components c ON c.id = ${componentId}::uuid AND c.company_id = e.company_id
     WHERE e.id = ${employeeId}::uuid AND e.company_id = ${companyId}::uuid AND e.tax_status = ${PSP}
  `) as DbRow[];
  const r = rows[0];
  if (!r) return;
  const kind = pspRefusedKind({ sarsSourceCode: String(r.sars_source_code ?? ''), componentType: String(r.component_type) });
  if (kind) throw new PspComponentRefused(pspRefusalMessage(`Employee ${String(r.employee_number)}`, [{ name: String(r.name), kind }]));
}

/**
 * Calculate: each PSP about to be costed with a live assignment (in the run's period) of a refused component, or an
 * active loan. One refusal names them all.
 */
export async function assertPspRunComponents(
  companyId: string, period: { start: string; end: string }, employeeIds: readonly string[], db: TxSql = sql,
): Promise<void> {
  if (employeeIds.length === 0) return;
  const rows = (await db`
    SELECT e.employee_number, c.name, c.sars_source_code, c.component_type, ec.quantity_unit
      FROM payroll_employees e
      JOIN payroll_employee_components ec ON ec.employee_id = e.id
      JOIN payroll_components c ON c.id = ec.component_id AND c.company_id = e.company_id
     WHERE e.company_id = ${companyId}::uuid AND e.tax_status = ${PSP}
       AND e.id::text = ANY(${[...employeeIds]}::text[])
       AND ec.superseded_at IS NULL
       AND ec.effective_from <= ${period.end}::date AND (ec.effective_to IS NULL OR ec.effective_to >= ${period.start}::date)
    UNION ALL
    -- L3: an approved IRP3(c) fixed-amount directive in force in the period (G21 p. 16 issues a PSP an IRP3(b)). UNVERIFIED.
    SELECT e.employee_number, 'Directive ' || COALESCE(d.directive_number, d.id::text), ${IRP3C_MARKER}, 'directive', NULL
      FROM payroll_employees e
      JOIN tax_directives d ON d.employee_id = e.id AND d.company_id = e.company_id
     WHERE e.company_id = ${companyId}::uuid AND e.tax_status = ${PSP}
       AND e.id::text = ANY(${[...employeeIds]}::text[])
       AND d.status = 'approved' AND d.directive_type = 'fixed_amount'
       AND d.effective_date <= ${period.end}::date AND COALESCE(d.expiry_date, 'infinity'::date) >= ${period.start}::date
    UNION ALL
    SELECT e.employee_number, 'Loan ' || COALESCE(l.loan_number, l.id::text), 'LOAN', 'deduction', NULL
      FROM payroll_employees e
      JOIN payroll_loans l ON l.employee_id = e.id AND l.company_id = e.company_id AND l.status = 'active'
     WHERE e.company_id = ${companyId}::uuid AND e.tax_status = ${PSP}
       AND e.id::text = ANY(${[...employeeIds]}::text[])
     ORDER BY 1, 2
  `) as DbRow[];
  const byEmployee = new Map<string, Array<{ name: string; kind: PspRefusedKind }>>();
  for (const r of rows) {
    // RI (review of #1580 M1): travel km on any component is reimbursive travel, refused as 3701-3722 are.
    const kind = pspRefusedKind({ sarsSourceCode: String(r.sars_source_code ?? ''), componentType: String(r.component_type) })
      ?? (r.quantity_unit === 'km' ? 'travel allowance' : null);
    if (!kind) continue;
    const who = String(r.employee_number);
    byEmployee.set(who, [...(byEmployee.get(who) ?? []), { name: String(r.name), kind }]);
  }
  if (byEmployee.size === 0) return;
  throw new PspComponentRefused([...byEmployee].map(([who, items]) => pspRefusalMessage(`Employee ${who}`, items)).join(' '));
}

/** The audit metadata key a bonus amount edit keeps an employee's approved PSP treatment under (payrollOffCycleAmount). */
export const PSP_TREATMENT_KEPT = 'pspTreatmentAtApproval:';

/**
 * Each employee's PSP treatment as approved on a REOPENED run (none for a run never approved), and now: from the stored
 * line's own flag, flat_psp or not and the PSP's entity (round 3); for an employee with no line, from the latest bonus
 * amount edit's audit row, which removed the lines and kept the treatment (review #1679 Codex M). `employeeIds` null:
 * every employee with either.
 */
export async function pspTreatmentsAtApproval(
  companyId: string, runId: string, employeeIds: readonly string[] | null, db: TxSql = sql,
): Promise<DbRow[]> {
  return (await db`
    WITH h AS (
      SELECT id, company_id FROM payroll_run_headers
       WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid AND reopened_at IS NOT NULL
    ), kept AS (
      SELECT a.changes->'metadata' AS m FROM audit_log a JOIN h ON a.company_id = h.company_id AND a.entity_id = h.id
       WHERE a.entity_type = 'payroll_run' AND a.action = 'update'
         AND a.changes->'fields' @> '[{"field": "off_cycle_bonus_amount"}]'::jsonb
       ORDER BY a.created_at DESC, a.id DESC LIMIT 1
    )
    SELECT x.employee_id, x.employee_number, x.was, x.now FROM (
      SELECT e.id::text AS employee_id, e.employee_number,
             CASE WHEN l.id IS NULL THEN (SELECT kept.m->>(${PSP_TREATMENT_KEPT} || e.id::text) FROM kept)
                  WHEN COALESCE(l.validation_results @> ${pspLineFlag}::jsonb, false)
                  THEN 'personal service provider (' || COALESCE((
                    SELECT v->'psp'->>'entity' FROM jsonb_array_elements(l.validation_results) v
                     WHERE v->>'code' = 'PAYE_OUTSIDE_TABLES' AND v->>'treatment' = 'flat_psp' LIMIT 1), 'entity not recorded') || ')'
                  ELSE 'not a personal service provider' END AS was,
             CASE WHEN e.tax_status = ${PSP} THEN 'personal service provider (' || COALESCE(e.psp_entity_type, 'no entity') || ')'
                  ELSE 'not a personal service provider' END AS now
        FROM h
        JOIN payroll_employees e ON e.company_id = h.company_id
        LEFT JOIN payroll_run_lines l ON l.run_id = h.id AND l.employee_id = e.id
       WHERE ${employeeIds === null}::boolean OR e.id::text = ANY(${[...(employeeIds ?? [])]}::text[])
    ) x
     WHERE x.was IS NOT NULL
     ORDER BY x.employee_number
  `) as DbRow[];
}

/**
 * M2: a REOPENED run (reopened_at set) is not recalculated under a different PSP treatment than it was approved under
 * (pspTreatmentsAtApproval). 409 PSP_STATUS_CHANGED_SINCE_APPROVAL, naming each employee with the treatment at
 * approval and now, before any write. A run never approved recalculates freely (its month is costed whole under the
 * status of the day).
 */
export async function assertReopenedRunKeepsPspTreatment(
  companyId: string, runId: string, employeeIds: readonly string[], db: TxSql = sql,
): Promise<void> {
  const rows = (await pspTreatmentsAtApproval(companyId, runId, employeeIds, db)).filter((r) => r.was !== r.now);
  if (rows.length === 0) return;
  throw new PspStatusChangedSinceApproval(rows.map((r) => ({ employee: String(r.employee_number), was: String(r.was), now: String(r.now) })));
}
