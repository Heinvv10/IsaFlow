/**
 * The regular-pay directive (IRP3(b) / IRP3(c)) a run applies to each employee, and the approval check that it still
 * does (wave 5 DR). Every query is scoped by company_id.
 *
 * The JUDGE DATE is the run's pay date (payroll_run_headers.run_date) when it has one, else the period's last day (the
 * day a severance directive is read on, payrollSeveranceDirective). In force = approved, effective on or before the judge
 * date and ending (expiry, else the tax year's end: G21 p. 15, taxDirectiveOverlap.directiveEndsOnSql) on or after it.
 * - `partial`: a window that starts or ends inside the period, applied (in force on the judge date) or not: warned
 *   (DIRECTIVE_PARTIAL_PERIOD), never silent.
 * - `ended`: in force on the previous period's last day and ended before the judge date (DIRECTIVE_ENDED).
 * - `overlapping` (two or more in force) and `invalid` (in force with no rate or amount above nil, a row written outside
 *   the route): none applies, the line carries an error and approval refuses.
 *
 * The calculation stores what it applied on the line (PAYE_OUTSIDE_TABLES, treatment 'directive', `directive.id`).
 * Approval refuses (`regular_directive_changed`) a run whose line names another directive than the one in force now, or
 * none where one is; and `regular_directive_overlap` / `regular_directive_invalid`. The rows are read FOR SHARE
 * (bounded), so an approve, cancel or expiry change of one waits for the run's approval to finish.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { withBoundedLockWait } from './payrollRunLock';
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';
import { REGULAR_PAY_DIRECTIVE_TYPES } from './taxDirectiveKinds';
import { directiveEndsOnSql } from './taxDirectiveOverlap';
import { DIRECTIVE_FOR_CONTRACTOR, type RegularPayDirective, type RegularPayDirectiveState } from './directiveRegularPay';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { PayrollPeriod } from './payrollTypes';

const types = (): string[] => [...REGULAR_PAY_DIRECTIVE_TYPES];
type LoadedState = RegularPayDirectiveState & { overlapping: string[]; invalid: string[]; partial: NonNullable<RegularPayDirectiveState['partial']> };

/** A stored row as the engine's directive, or null when it carries no usable figure. */
function toDirective(r: DbRow): RegularPayDirective | null {
  const base = {
    id: String(r.id), number: r.directive_number == null ? null : String(r.directive_number),
    endsOn: String(r.ends_on), effectiveDate: String(r.effective_date),
  };
  const rate = r.tax_rate == null ? NaN : Number(r.tax_rate);
  const amount = r.tax_amount == null ? NaN : Number(r.tax_amount);
  if (r.directive_type === 'fixed_percentage' && rate > 0 && rate <= 1) return { ...base, type: 'fixed_percentage', rate, fixedAmount: null };
  if (r.directive_type === 'fixed_amount' && amount > 0) return { ...base, type: 'fixed_amount', rate: null, fixedAmount: amount };
  return null;
}

/** By employee id (see the header). `runId` names the run whose pay date judges; without it, the period's last day. */
export async function loadRegularPayDirectives(
  companyId: string, employeeIds: string[], period: PayrollPeriod, runId: string | null = null,
): Promise<Map<string, LoadedState>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (await sql`
    WITH b AS (
      SELECT make_date(${period.year}::int, ${period.month}::int, 1) AS first_day,
             (make_date(${period.year}::int, ${period.month}::int, 1) + INTERVAL '1 month - 1 day')::date AS last_day
    ), p AS (
      SELECT b.first_day, b.last_day, (b.first_day - 1) AS prev_last_day,
             COALESCE((SELECT h.run_date FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid), b.last_day) AS judge
      FROM b
    ), d AS (
      SELECT d.id, d.employee_id, d.directive_number, d.directive_type, d.tax_rate, d.tax_amount, d.effective_date,
             ${directiveEndsOnSql('d')} AS ends_on
      FROM tax_directives d
      WHERE d.company_id = ${companyId}::uuid AND d.employee_id = ANY(${employeeIds}::uuid[])
        AND d.status = 'approved' AND d.directive_type = ANY(${types()}::text[])
    )
    SELECT d.id, d.employee_id, d.directive_number, d.directive_type, d.tax_rate, d.tax_amount,
           d.effective_date::text AS effective_date, d.ends_on::text AS ends_on,
           (d.effective_date <= p.judge AND d.ends_on >= p.judge) AS in_force,
           (d.effective_date <= p.last_day AND d.ends_on >= p.first_day AND (d.effective_date > p.first_day OR d.ends_on < p.last_day)) AS partial,
           (d.effective_date <= p.prev_last_day AND d.ends_on >= p.prev_last_day AND d.ends_on < p.judge) AS ended
    FROM d CROSS JOIN p
    WHERE (d.effective_date <= p.last_day AND d.ends_on >= p.first_day)
       OR (d.effective_date <= p.prev_last_day AND d.ends_on >= p.prev_last_day AND d.ends_on < p.judge)
    ORDER BY d.employee_id, d.effective_date, d.id
  `) as DbRow[];
  const out = new Map<string, LoadedState>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const state = out.get(key) ?? { current: null, ended: null, partial: [], overlapping: [], invalid: [] };
    const d = toDirective(r);
    const name = r.directive_number ? String(r.directive_number) : String(r.id);
    if (r.in_force === true) {
      state.overlapping.push(name);
      if (d) state.current = d; else state.invalid.push(name);
    }
    if (r.ended === true && d) state.ended ??= d;
    if (r.partial === true && d) state.partial.push({ directive: d, applied: r.in_force === true });
    out.set(key, state);
  }
  for (const state of out.values()) {
    if (state.overlapping.length !== 1 || state.invalid.length > 0) state.current = null;
  }
  return out;
}

/** The approval gate's refusal for the run's regular-pay directives, or null (see the header). */
export async function regularDirectiveRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const lines = (await sql`
    SELECT l.employee_id, e.employee_number, h.period_year, h.period_month,
           (SELECT v->'directive'->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.validation_results) = 'array' THEN l.validation_results ELSE '[]'::jsonb END) v
             WHERE v->>'code' = ${PAYE_OUTSIDE_TABLES} AND v->>'treatment' = 'directive' LIMIT 1) AS applied,
           COALESCE(l.validation_results @> ${JSON.stringify([{ code: DIRECTIVE_FOR_CONTRACTOR }])}::jsonb, false) AS contractor_directive
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
  const now = await loadRegularPayDirectives(companyId, ids, { year: Number(lines[0]!.period_year), month: Number(lines[0]!.period_month) }, runId);
  const named = (pick: (s: LoadedState) => boolean) => lines.filter(l => { const s = now.get(String(l.employee_id)); return s != null && pick(s); });
  const overlap = named(s => s.overlapping.length > 1);
  if (overlap.length > 0) {
    return {
      code: 'regular_directive_overlap',
      detail: `${overlap.map(l => `${String(l.employee_number)} (${now.get(String(l.employee_id))!.overlapping.join(', ')})`).join('; ')}: `
        + 'two approved fixed-percentage or fixed-amount directives are in force this period. Cancel one or give it an expiry date (Payroll, Tax directives), then recalculate.',
    };
  }
  const invalid = named(s => s.invalid.length > 0);
  if (invalid.length > 0) {
    return {
      code: 'regular_directive_invalid',
      detail: `${invalid.map(l => String(l.employee_number)).join(', ')}: an approved fixed-percentage or fixed-amount directive carries no rate or amount. `
        + 'Cancel it and capture the directive again, then recalculate.',
    };
  }
  const contractors = lines.filter(l => l.contractor_directive === true);
  if (contractors.length > 0) {
    return {
      code: 'regular_directive_contractor',
      detail: `${contractors.map(l => String(l.employee_number)).join(', ')}: an independent contractor has a fixed-percentage or fixed-amount directive. `
        + 'Restore the employee\'s tax status (employee profile, Work terms); or, for a run never approved, cancel the directive. Then recalculate.',
    };
  }
  const changed = lines.filter(l => (l.applied == null ? null : String(l.applied)) !== (now.get(String(l.employee_id))?.current?.id ?? null));
  if (changed.length === 0) return null;
  return {
    code: 'regular_directive_changed',
    detail: `A fixed-percentage or fixed-amount SARS directive was approved, cancelled, shortened or ended after this run was calculated for `
      + `${changed.map(l => String(l.employee_number)).join(', ')}: the run still holds the old PAYE. Recalculate this run, then approve it.`,
  };
}

/**
 * A run that was EVER approved: approved or paid now, or approved once and reopened since (approved_at, reopened_at, a
 * non-empty approval_history, as the K1 first-entry rule reads it). Reopening a run does not unmake what it declared, so
 * a reopened run still holds its directive (#1266 round 2 M1). A run never approved (a draft) does not.
 */
const everApproved = (declarable: string[]) => sql`(h.status = ANY(${declarable}::text[]) OR h.approved_at IS NOT NULL OR h.reopened_at IS NOT NULL
  OR (h.approval_history IS NOT NULL AND NOT isempty(h.approval_history)))`;

/** The first run ever approved (YYYY-MM) this employee was paid in whose judge date falls in [from, to], else null. */
export async function declarableRunInWindow(
  companyId: string, employeeId: string, from: string, to: string, exceptPeriods: string[] = [],
): Promise<string | null> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT h.period_year, h.period_month
    FROM payroll_run_headers h
    WHERE h.company_id = ${companyId}::uuid AND ${everApproved(declarable)}
      -- Paid in it: a line now, or (reopened, the lines rewritten since) taxed by an earlier approved version
      -- (approved_taxed_employees, migration 925; NULL on a reopened run = unknown, fail closed), or a recorded directive use.
      AND (EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = h.id AND l.employee_id = ${employeeId}::uuid) OR ${employeeId}::uuid = ANY(COALESCE(h.approved_taxed_employees, '{}'::uuid[]))
        OR (h.reopened_at IS NOT NULL AND h.approved_taxed_employees IS NULL)
        OR EXISTS (SELECT 1 FROM payroll_run_directive_uses u WHERE u.company_id = h.company_id AND u.run_id = h.id AND u.employee_id = ${employeeId}::uuid))
      AND COALESCE(h.run_date, (make_date(h.period_year, h.period_month, 1) + INTERVAL '1 month - 1 day')::date) BETWEEN ${from}::date AND ${to}::date
      -- 'YYYY-MM' periods the caller owns (the leaver-exit undo: the reopened runs the exit named).
      AND to_char(make_date(h.period_year, h.period_month, 1), 'YYYY-MM') <> ALL(${exceptPeriods}::text[])
    ORDER BY h.period_year, h.period_month
    LIMIT 1
  `) as DbRow[];
  return rows[0] ? `${String(rows[0].period_year)}-${String(rows[0].period_month).padStart(2, '0')}` : null;
}
