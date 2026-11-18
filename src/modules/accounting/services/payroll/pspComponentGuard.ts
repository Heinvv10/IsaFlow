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

const PSP = 'personal_service_provider';

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
    SELECT e.employee_number, c.name, c.sars_source_code, c.component_type
      FROM payroll_employees e
      JOIN payroll_employee_components ec ON ec.employee_id = e.id
      JOIN payroll_components c ON c.id = ec.component_id AND c.company_id = e.company_id
     WHERE e.company_id = ${companyId}::uuid AND e.tax_status = ${PSP}
       AND e.id::text = ANY(${[...employeeIds]}::text[])
       AND ec.superseded_at IS NULL
       AND ec.effective_from <= ${period.end}::date AND (ec.effective_to IS NULL OR ec.effective_to >= ${period.start}::date)
    UNION ALL
    -- L3: an approved IRP3(c) fixed-amount directive in force in the period (G21 p. 16 issues a PSP an IRP3(b)). UNVERIFIED.
    SELECT e.employee_number, 'Directive ' || COALESCE(d.directive_number, d.id::text), ${IRP3C_MARKER}, 'directive'
      FROM payroll_employees e
      JOIN tax_directives d ON d.employee_id = e.id AND d.company_id = e.company_id
     WHERE e.company_id = ${companyId}::uuid AND e.tax_status = ${PSP}
       AND e.id::text = ANY(${[...employeeIds]}::text[])
       AND d.status = 'approved' AND d.directive_type = 'fixed_amount'
       AND d.effective_date <= ${period.end}::date AND COALESCE(d.expiry_date, 'infinity'::date) >= ${period.start}::date
    UNION ALL
    SELECT e.employee_number, 'Loan ' || COALESCE(l.loan_number, l.id::text), 'LOAN', 'deduction'
      FROM payroll_employees e
      JOIN payroll_loans l ON l.employee_id = e.id AND l.company_id = e.company_id AND l.status = 'active'
     WHERE e.company_id = ${companyId}::uuid AND e.tax_status = ${PSP}
       AND e.id::text = ANY(${[...employeeIds]}::text[])
     ORDER BY 1, 2
  `) as DbRow[];
  const byEmployee = new Map<string, Array<{ name: string; kind: PspRefusedKind }>>();
  for (const r of rows) {
    const kind = pspRefusedKind({ sarsSourceCode: String(r.sars_source_code ?? ''), componentType: String(r.component_type) });
    if (!kind) continue;
    const who = String(r.employee_number);
    byEmployee.set(who, [...(byEmployee.get(who) ?? []), { name: String(r.name), kind }]);
  }
  if (byEmployee.size === 0) return;
  throw new PspComponentRefused([...byEmployee].map(([who, items]) => pspRefusalMessage(`Employee ${who}`, items)).join(' '));
}

/**
 * M2: a REOPENED run (reopened_at set) is not recalculated under a different PSP treatment than its approved lines carry
 * (flat_psp or not, read from each stored line's own flag): 409 PSP_STATUS_CHANGED_SINCE_APPROVAL, naming the employees,
 * before any write. A run never approved recalculates freely (its month is costed whole under the status of the day).
 */
export async function assertReopenedRunKeepsPspTreatment(
  companyId: string, runId: string, employeeIds: readonly string[], db: TxSql = sql,
): Promise<void> {
  const rows = (await db`
    SELECT e.employee_number
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid AND h.reopened_at IS NOT NULL
       AND l.employee_id::text = ANY(${[...employeeIds]}::text[])
       AND COALESCE(l.validation_results @> ${pspLineFlag}::jsonb, false) <> (e.tax_status = ${PSP})
     ORDER BY e.employee_number
  `) as DbRow[];
  if (rows.length === 0) return;
  throw new PspStatusChangedSinceApproval(rows.map((r) => String(r.employee_number)));
}
