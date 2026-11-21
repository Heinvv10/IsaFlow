/**
 * Who an off-cycle run pays and what (wave 6 OC; created by payrollOffCycleRun, stored in payroll_off_cycle_employees,
 * migration 999x). calculatePayrollRun costs these in place of the month's population:
 *  - bonus        the one annual-payment earning (3605) and amount the run was created with: no salary, no recurring
 *                 component, no loan or deduction;
 *  - termination  the leaver's termination pay-outs (leave and notice pay, 3605; severance only by directive), by the
 *                 final run's own rule (payrollRunTermination.appendTerminationIfEndingThisPeriod) on no other pay.
 * Each line carries the month's earlier final lines (payrollOffCycleMonthRead) for the month's UIF cap and ETI.
 * Scoped by company_id throughout.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { mapPayrollEmployeeRow } from './payrollEmployeeService';
import { mapComponent } from './payrollComponentService';
import { appendTerminationIfEndingThisPeriod } from './payrollRunTermination';
import { loadRegularPayDirectives } from './payrollRunRegularDirective';
import { loadMonthEarlierLines } from './payrollOffCycleMonthRead';
import { NO_EARLIER_LINES, type MonthEarlierLines } from './payrollOffCycleMonth';
import { OffCycleRunRefusedError } from './payrollOffCycleRun';
import { normaliseSarsCode } from './payeAnnualPayment';
import type { PreparedRunEmployee } from './payrollRunComponents';
import type { PayrollEmployee, PayrollPeriod, ValidationResult } from './payrollTypes';

export interface OffCyclePrepared extends PreparedRunEmployee { monthEarlier: MonthEarlierLines }

/** The run's employees, as stored at creation (none for a run that is not off-cycle). */
export async function listOffCycleEmployees(companyId: string, runId: string): Promise<PayrollEmployee[]> {
  const rows = (await sql`
    SELECT e.* FROM payroll_off_cycle_employees x
      JOIN payroll_employees e ON e.id = x.employee_id AND e.company_id = x.company_id
     WHERE x.company_id = ${companyId}::uuid AND x.run_id = ${runId}::uuid
     ORDER BY e.last_name, e.first_name
  `) as DbRow[];
  return rows.map(mapPayrollEmployeeRow);
}

export async function prepareOffCycleComponents(args: {
  companyId: string; runId: string; period: PayrollPeriod; reason: 'bonus' | 'termination'; employees: PayrollEmployee[];
}): Promise<OffCyclePrepared[]> {
  const { companyId, runId, period, reason, employees } = args;
  const ids = employees.map((e) => e.id);
  const bonuses = new Map(((await sql`
    SELECT x.employee_id, x.amount, pc.*
      FROM payroll_off_cycle_employees x
      JOIN payroll_components pc ON pc.id = x.component_id AND pc.company_id = x.company_id
     WHERE x.company_id = ${companyId}::uuid AND x.run_id = ${runId}::uuid
  `) as DbRow[]).map((r) => [String(r.employee_id), r]));
  const directives = await loadRegularPayDirectives(companyId, ids, period, runId);
  const earlier = await loadMonthEarlierLines(companyId, runId, ids);
  const out: OffCyclePrepared[] = [];
  for (const employee of employees) {
    const terminationWarnings: ValidationResult[] = [];
    const bonus = bonuses.get(employee.id);
    // The component may have changed since creation (review #1679 Codex of 7630d9379): a bonus is costed only on a
    // taxable 3605 earning, else it would add to gross pay and nothing to PAYE.
    if (reason === 'bonus' && bonus && !(bonus.component_type === 'earning' && bonus.is_taxable === true
      && normaliseSarsCode(String(bonus.sars_source_code ?? '')) === '3605')) {
      throw new OffCycleRunRefusedError(`${employee.firstName} ${employee.lastName}'s bonus component "${String(bonus.name)}" is no longer `
        + 'a taxable annual-payment earning (SARS code 3605): correct the component before calculating.', 409);
    }
    const components = reason === 'bonus'
      ? (bonus ? [{ component: mapComponent(bonus), amount: Number(bonus.amount) }] : [])
      : await appendTerminationIfEndingThisPeriod(companyId, runId, employee, [], period, terminationWarnings);
    out.push({
      employee, severanceOnly: false, components, terminationWarnings,
      regularPayDirective: directives.get(employee.id) ?? { current: null, ended: null },
      monthEarlier: earlier.get(employee.id) ?? NO_EARLIER_LINES,
    });
  }
  return out;
}
