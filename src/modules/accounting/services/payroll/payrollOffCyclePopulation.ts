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
import { payRunFinalSql } from './payRunFinalSql';
import { PAYROLL_REFUSAL } from './payrollRefusalCodes';
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

/**
 * A termination run's leavers as they stand at calculation (gate ruling 3 on e0eec1dea1), as creation judged them:
 * each still leaves in the run's month, with a termination reason. A reason cleared since would drop that leaver's
 * pay-outs while another leaver's gross carried the run past the approval guard: 409 before anything is costed.
 */
async function assertLeaversStillLeaving(companyId: string, ids: string[], period: PayrollPeriod): Promise<void> {
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const rows = (await sql`
    SELECT employee_number, first_name, last_name, end_date::text AS end_date, termination_reason
      FROM payroll_employees WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])
     ORDER BY employee_number
  `) as DbRow[];
  const who = (r: DbRow) => `${`${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim()} (${String(r.employee_number)})`;
  const notLeaving = rows.filter((r) => String(r.end_date ?? '').slice(0, 7) !== month).map(who);
  if (notLeaving.length > 0) {
    throw new OffCycleRunRefusedError(`${notLeaving.join(', ')}: no longer leaving in ${month}; record the termination again or cancel this run.`, 409);
  }
  const noReason = rows.filter((r) => r.termination_reason == null || String(r.termination_reason).trim() === '').map(who);
  if (noReason.length > 0) {
    throw new OffCycleRunRefusedError(`${noReason.join(', ')}: leaving with no termination reason, so the pay-outs cannot be costed. `
      + 'Record the termination (with its reason) first.', 409, PAYROLL_REFUSAL.TERMINATION_REASON_MISSING);
  }
}

/**
 * A bonus is costed on the employee's line of the month's final regular run (gate item 2 on 06c106a94d), as creation
 * judged it: each must still have one at calculation. One reopened and recalculated without them is refused (409,
 * REGULAR_LINE_MISSING), never costed as a month with no earlier line.
 */
async function assertOnFinalRegularRun(companyId: string, runId: string, ids: string[]): Promise<void> {
  const rows = (await sql`
    SELECT e.employee_number, e.first_name, e.last_name
      FROM payroll_employees e
     WHERE e.company_id = ${companyId}::uuid AND e.id = ANY(${ids}::uuid[])
       AND NOT EXISTS (
         SELECT 1 FROM payroll_run_headers me
           JOIN payroll_run_headers o
             ON o.company_id = me.company_id AND o.period_year = me.period_year AND o.period_month = me.period_month
            AND o.pay_frequency = me.pay_frequency AND o.run_kind = 'regular'
           JOIN payroll_run_lines l ON l.run_id = o.id AND l.employee_id = e.id
          WHERE me.id = ${runId}::uuid AND me.company_id = ${companyId}::uuid AND ${sql.unsafe(payRunFinalSql('o'))})
     ORDER BY e.employee_number
  `) as DbRow[];
  if (rows.length === 0) return;
  const who = rows.map((r) => `${`${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim()} (${String(r.employee_number)})`);
  throw new OffCycleRunRefusedError(`${who.join(', ')}: not on the month's final regular run, so a bonus cannot be costed on it. `
    + 'Approve the regular run with them on it, or take them off this bonus run.', 409, PAYROLL_REFUSAL.REGULAR_LINE_MISSING);
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
  if (reason === 'termination') await assertLeaversStillLeaving(companyId, ids, period);
  if (reason === 'bonus') await assertOnFinalRegularRun(companyId, runId, ids);
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
