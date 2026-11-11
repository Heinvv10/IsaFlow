/**
 * The regular-pay directive (IRP3(b) / IRP3(c)) a run applies to each employee, and the approval check that it still
 * does (wave 5 DR). Every query is scoped by company_id.
 *
 * In force for a period = approved, and in force on the period's last day (the day a severance directive is read on,
 * payrollSeveranceDirective): effective on or before it, ending (expiry, else the tax year's end: G21 p. 15,
 * taxDirectiveOverlap.directiveEndsOnSql) on or after it. `ended` is one that was in force on the previous period's last
 * day and is not on this one (the first month back on the tables: directiveEndedResult).
 *
 * The calculation stores what it applied on the line (PAYE_OUTSIDE_TABLES, treatment 'directive', `directive.id`).
 * Approval refuses (`regular_directive_changed`) a run whose line names another directive than the one in force now, or
 * none where one is (approved, cancelled or created after calculation), and an employee with two in force
 * (`regular_directive_overlap`: taxDirectiveOverlap prevents it; a row written outside it fails closed here). The rows
 * are read FOR SHARE (bounded), so an approve or cancel of one waits for the run's approval to finish.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { withBoundedLockWait } from './payrollRunLock';
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';
import { REGULAR_PAY_DIRECTIVE_TYPES, type RegularPayDirectiveType } from './taxDirectiveKinds';
import { directiveEndsOnSql } from './taxDirectiveOverlap';
import type { RegularPayDirective, RegularPayDirectiveState } from './directiveRegularPay';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { PayrollPeriod } from './payrollTypes';

const types = (): string[] => [...REGULAR_PAY_DIRECTIVE_TYPES];

/** By employee id: the directive in force this period (null when none, or when two are: `overlapping` names them) and the one that ended. */
export async function loadRegularPayDirectives(
  companyId: string, employeeIds: string[], period: PayrollPeriod,
): Promise<Map<string, RegularPayDirectiveState & { overlapping: string[] }>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (await sql`
    WITH p AS (
      SELECT (make_date(${period.year}::int, ${period.month}::int, 1) + INTERVAL '1 month - 1 day')::date AS last_day,
             (make_date(${period.year}::int, ${period.month}::int, 1) - INTERVAL '1 day')::date AS prev_last_day
    ), d AS (
      SELECT d.id, d.employee_id, d.directive_number, d.directive_type, d.tax_rate, d.tax_amount, d.effective_date,
             ${directiveEndsOnSql('d')} AS ends_on
      FROM tax_directives d
      WHERE d.company_id = ${companyId}::uuid AND d.employee_id = ANY(${employeeIds}::uuid[])
        AND d.status = 'approved' AND d.directive_type = ANY(${types()}::text[])
    )
    SELECT d.id, d.employee_id, d.directive_number, d.directive_type, d.tax_rate, d.tax_amount, d.ends_on::text AS ends_on,
           (d.effective_date <= p.last_day AND d.ends_on >= p.last_day) AS in_force
    FROM d CROSS JOIN p
    WHERE (d.effective_date <= p.last_day AND d.ends_on >= p.last_day)
       OR (d.effective_date <= p.prev_last_day AND d.ends_on >= p.prev_last_day AND d.ends_on < p.last_day)
    ORDER BY d.employee_id, d.ends_on DESC, d.id
  `) as DbRow[];
  const out = new Map<string, RegularPayDirectiveState & { overlapping: string[] }>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const state = out.get(key) ?? { current: null, ended: null, overlapping: [] };
    const d: RegularPayDirective = {
      id: String(r.id), number: r.directive_number == null ? null : String(r.directive_number),
      type: String(r.directive_type) as RegularPayDirectiveType,
      rate: r.tax_rate == null ? null : Number(r.tax_rate), fixedAmount: r.tax_amount == null ? null : Number(r.tax_amount),
      endsOn: String(r.ends_on),
    };
    if (r.in_force !== true) state.ended ??= d;
    else state.overlapping.push(d.number ?? d.id);
    if (r.in_force === true) state.current = state.overlapping.length === 1 ? d : null;
    out.set(key, state);
  }
  return out;
}

/** The approval gate's refusal for the run's regular-pay directives, or null (see the header). */
export async function regularDirectiveRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const lines = (await sql`
    SELECT l.employee_id, e.employee_number, h.period_year, h.period_month,
           (SELECT v->'directive'->>'id' FROM jsonb_array_elements(COALESCE(l.validation_results, '[]'::jsonb)) v
             WHERE v->>'code' = ${PAYE_OUTSIDE_TABLES} AND v->>'treatment' = 'directive' LIMIT 1) AS applied
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid
    ORDER BY e.employee_number
  `) as DbRow[];
  if (lines.length === 0) return null;
  const ids = lines.map(l => String(l.employee_id));
  await withBoundedLockWait(runId, async (tx) => tx`
    SELECT id FROM tax_directives
    WHERE company_id = ${companyId}::uuid AND employee_id = ANY(${ids}::uuid[]) AND directive_type = ANY(${types()}::text[])
    ORDER BY id FOR SHARE
  `);
  const now = await loadRegularPayDirectives(companyId, ids, { year: Number(lines[0]!.period_year), month: Number(lines[0]!.period_month) });
  const overlap = lines.filter(l => (now.get(String(l.employee_id))?.overlapping.length ?? 0) > 1);
  if (overlap.length > 0) {
    return {
      code: 'regular_directive_overlap',
      detail: `${overlap.map(l => `${String(l.employee_number)} (${now.get(String(l.employee_id))!.overlapping.join(', ')})`).join('; ')}: `
        + 'two approved fixed-percentage or fixed-amount directives are in force this period. Cancel one (Payroll, Tax directives), then recalculate.',
    };
  }
  const changed = lines.filter(l => (l.applied == null ? null : String(l.applied)) !== (now.get(String(l.employee_id))?.current?.id ?? null));
  if (changed.length === 0) return null;
  return {
    code: 'regular_directive_changed',
    detail: `A fixed-percentage or fixed-amount SARS directive was approved, cancelled or ended after this run was calculated for `
      + `${changed.map(l => String(l.employee_number)).join(', ')}: the run still holds the old PAYE. Recalculate this run, then approve it.`,
  };
}

/** The first approved or paid run (YYYY-MM) whose line was taxed by this directive, else null. */
export async function regularDirectiveUsedBy(companyId: string, directiveId: string): Promise<string | null> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const flag = JSON.stringify([{ code: PAYE_OUTSIDE_TABLES, directive: { id: directiveId } }]);
  const rows = (await sql`
    SELECT h.period_year, h.period_month
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    WHERE h.company_id = ${companyId}::uuid AND h.status = ANY(${declarable}::text[])
      AND l.validation_results @> ${flag}::jsonb
    ORDER BY h.period_year, h.period_month
    LIMIT 1
  `) as DbRow[];
  return rows[0] ? `${String(rows[0].period_year)}-${String(rows[0].period_month).padStart(2, '0')}` : null;
}
