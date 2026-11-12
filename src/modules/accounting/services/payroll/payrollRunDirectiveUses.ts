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
 *   One exit (round 4 L2): an employee who really left before the period, whose directive was ended at the leave date
 *   (the expiry guard allows that date only for a leaver), may leave the run: no line is left for the tables to tax.
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
           -- Ended at the leave date (expiry before this run's judge date, allowed only for a leaver): the leaver may leave the run.
           (d.status = 'approved' AND ${directiveEndsOnSql('d')} < u.judge_date AND e.end_date IS NOT NULL
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
