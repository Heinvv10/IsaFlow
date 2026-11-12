/**
 * The durable record of which regular-pay directive (IRP3(b)/(c)) taxed which employee on which approved run
 * (payroll_run_directive_uses, migration 979; wave 5 DR, #1266 round 3 M1). A run's lines are rewritten by every
 * recalculation, so a reopened run's lines are not a record of what it declared; this is. Company-scoped throughout.
 *
 * - recordRegularDirectiveUses: written by every run approval (payrollRunDirectiveClaim.claimRunSeveranceDirectives),
 *   on its transaction, from the lines being approved; never deleted (a reopen does not touch it).
 * - regularDirectiveLatestUse: the latest recorded use of a directive (cancel 409, expiry 400, delete 409 read it).
 * - assertRunKeepsItsDirectives: a recalculation of an ever-approved run is REFUSED (409, nothing written: judged before
 *   the first write) when a recorded (employee, directive) of that run would not be applied again: the employee left the
 *   run's population, became an independent contractor, or the directive is not the one in force for the period. A
 *   directive legitimately shortened stays in force for every run it taxed (the expiry guard), so it never trips this.
 *   One exit (round 4 L2): an employee who really left BEFORE the taxed period (end date before its first day), whose
 *   directive was ended at the leave date (the expiry guard allows that only for such a leaver), may leave the run: no
 *   line is left for the tables to tax. The exit holds only while the end date does: assertEndDateKeepsDirectiveExits
 *   refuses (409) an end-date change that would leave such a run taxed without its directive (security review, round 4).
 * - regularDirectiveUsesAfter: the recorded uses judged after a date (the expiry guard's leaver check).
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';
import { directiveEndsOnSql } from './taxDirectiveOverlap';
import type { RegularPayDirectiveState } from './directiveRegularPay';
import type { PayrollEmployee } from './payrollTypes';

export class PayrollRunDirectiveUseError extends Error {
  readonly code = 'PAYROLL_RUN_DIRECTIVE_USE';
  constructor(message: string) {
    super(message);
    this.name = 'PayrollRunDirectiveUseError';
  }
}

/** Record the regular-pay directives the run's lines (as approved now) were taxed by. Idempotent. */
export async function recordRegularDirectiveUses(tx: TxSql, companyId: string, runId: string): Promise<void> {
  await tx`
    INSERT INTO payroll_run_directive_uses (company_id, run_id, employee_id, directive_id, period_year, period_month, judge_date)
    SELECT DISTINCT h.company_id, l.run_id, l.employee_id, d.id, h.period_year, h.period_month,
           COALESCE(h.run_date, (make_date(h.period_year, h.period_month, 1) + INTERVAL '1 month - 1 day')::date)
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.validation_results) = 'array' THEN l.validation_results ELSE '[]'::jsonb END) v
    JOIN tax_directives d ON d.id::text = v->'directive'->>'id' AND d.company_id = h.company_id
    WHERE h.id = ${runId}::uuid AND v->>'code' = ${PAYE_OUTSIDE_TABLES} AND v->>'treatment' = 'directive'
    ON CONFLICT (run_id, employee_id, directive_id) DO NOTHING
  `;
}

/** The latest recorded use of the directive: its run's period (YYYY-MM) and judge date, else null. */
export async function regularDirectiveLatestUse(companyId: string, directiveId: string): Promise<{ period: string; judgeDate: string } | null> {
  const r = ((await sql`
    SELECT period_year, period_month, judge_date::text AS judge
    FROM payroll_run_directive_uses
    WHERE company_id = ${companyId}::uuid AND directive_id = ${directiveId}::uuid
    ORDER BY judge_date DESC
    LIMIT 1
  `) as DbRow[])[0];
  return r ? { period: `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`, judgeDate: String(r.judge) } : null;
}

/** Refuse the recalculation of an ever-approved run that would not apply a recorded directive again (see the header). */
export async function assertRunKeepsItsDirectives(
  companyId: string, runId: string,
  population: Array<{ employee: PayrollEmployee; severanceOnly: boolean }>,
  directives: Map<string, RegularPayDirectiveState>,
): Promise<void> {
  const uses = (await sql`
    SELECT u.employee_id, u.directive_id, d.directive_number, e.employee_number,
           -- Ended at the leave date of an employee who left BEFORE this taxed period: the leaver may leave the run.
           (d.status = 'approved' AND ${directiveEndsOnSql('d')} < u.judge_date AND e.end_date IS NOT NULL
            AND e.end_date < make_date(u.period_year, u.period_month, 1)
            AND ${directiveEndsOnSql('d')} >= e.end_date) AS ended_at_leave
    FROM payroll_run_directive_uses u
    JOIN tax_directives d ON d.id = u.directive_id AND d.company_id = u.company_id
    JOIN payroll_employees e ON e.id = u.employee_id AND e.company_id = u.company_id
    WHERE u.company_id = ${companyId}::uuid AND u.run_id = ${runId}::uuid
    ORDER BY e.employee_number
  `) as DbRow[];
  const lost = uses.filter((u) => {
    const member = population.find((p) => p.employee.id === String(u.employee_id) && !p.severanceOnly);
    // A leaver no longer in the run whose directive was ended at the leave date: no line is left to be taxed by the tables.
    if (!member) return u.ended_at_leave !== true;
    if (member.employee.taxStatus === 'independent_contractor') return true;
    return directives.get(String(u.employee_id))?.current?.id !== String(u.directive_id);
  });
  if (lost.length === 0) return;
  throw new PayrollRunDirectiveUseError(
    `This run was approved with SARS directive ${lost.map((u) => `${String(u.directive_number ?? u.directive_id)} for ${String(u.employee_number)}`).join(', ')}, `
    + 'and recalculating it now would not apply it, so its declared PAYE would change. To proceed: restore what changed (the employee\'s '
    + 'tax status, since an independent contractor takes no directive; or their end date or status) and recalculate; or, for an employee '
    + 'who really left before this period, end the directive at the leave date, or at its effective date if that is later (Payroll, Tax directives, Set expiry), '
    + 'then recalculate, which takes the leaver out of this run.',
  );
}

/** The recorded uses of a directive judged after `date`: each run's first day (YYYY-MM-DD) and period (YYYY-MM). */
export async function regularDirectiveUsesAfter(companyId: string, directiveId: string, date: string): Promise<Array<{ firstDay: string; period: string }>> {
  const rows = (await sql`
    SELECT make_date(period_year, period_month, 1)::text AS first_day, period_year, period_month
    FROM payroll_run_directive_uses
    WHERE company_id = ${companyId}::uuid AND directive_id = ${directiveId}::uuid AND judge_date > ${date}::date
    ORDER BY first_day
  `) as DbRow[];
  return rows.map(r => ({ firstDay: String(r.first_day), period: `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}` }));
}

export class EmployeeEndDateDirectiveError extends Error {
  readonly code = 'EMPLOYEE_END_DATE_DIRECTIVE';
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeEndDateDirectiveError';
  }
}

/**
 * Called by the employee update, under the employee row lock and the company payroll lock, when the end date changes: refuse
 * (409, before the write) a new end date that would no longer explain a directive ended before a run it taxed (the leaver
 * exit): the employee must have left before that run's period, on or before the directive's end.
 */
export async function assertEndDateKeepsDirectiveExits(db: TxSql, companyId: string, employeeId: string, newEnd: string): Promise<void> {
  const rows = (await db`
    SELECT d.directive_number, d.id AS directive_id, u.period_year, u.period_month,
           make_date(u.period_year, u.period_month, 1)::text AS first_day, (${directiveEndsOnSql('d')})::text AS ends_on
    FROM payroll_run_directive_uses u
    JOIN tax_directives d ON d.id = u.directive_id AND d.company_id = u.company_id
    WHERE u.company_id = ${companyId}::uuid AND u.employee_id = ${employeeId}::uuid
      AND d.status = 'approved' AND ${directiveEndsOnSql('d')} < u.judge_date
  `) as DbRow[];
  const broken = rows.filter(r => !(newEnd < String(r.first_day) && String(r.ends_on) >= newEnd));
  if (broken.length === 0) return;
  const r = broken[0]!;
  throw new EmployeeEndDateDirectiveError(
    `SARS directive ${String(r.directive_number ?? r.directive_id)} was ended on ${String(r.ends_on)}, before the `
    + `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')} payroll run it taxed, because this employee left before that period. `
    + 'That end date cannot change now: the run would no longer be explained. Keep the end date, or ask your accountant how to correct the leave.',
  );
}
