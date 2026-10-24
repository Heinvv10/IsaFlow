/**
 * The stale year-to-date judgement of the approval gate (PAYE 4a follow-ups
 * G4 and round 2, R1): whether a run's cumulative PAYE and the other approved
 * months of its tax year were computed against each other as both now stand.
 * Its own module: payrollYearToDate.ts holds what a calculation reads.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { PAYE_TAX_YEAR_START_MONTH } from '@/modules/accounting/utils/payeTaxYear';
import type { PayrollJournalNote } from './payrollJournalBuilder';

/** The blocker approval raises (null when current), and advisories it does not refuse for. */
export interface YearToDateJudgement {
  blocker: PayrollJournalNote | null;
  advisories: PayrollJournalNote[];
}

/**
 * The approval-gate blocker for a run judged on a stale picture of its tax
 * year (PAYE 4a follow-ups G4; exact since round 2, R1).
 *
 * THE RULE: refused when another approved month of the tax year and this run
 * were not computed against each other as both now stand, unless (later month
 * only) each employee that month pays from the tables and this run still taxes
 * carries, on this run's line, the warning naming that month — an employee this
 * run no longer taxes can carry none, so only reopening that month clears it.
 * COMPLETE for approved pairs: a later month's year-to-date per employee is
 * the earlier month's lines as they were when it was calculated — the same
 * version (nothing stale), none (stale where the earlier month taxes them now)
 * or an older version (stale for anyone the later month taxes); a pair is
 * first judged when its second member is approved, and neither can change
 * again without a reopen and a new approval, which judges it again. What it
 * does not cover: NAMED LIMITS below.
 *
 * In detail, for each OTHER month of the same tax year approved or paid now:
 * - EARLIER month: this run's cumulative PAYE missed it — that month, as it
 *   now stands, was not approved when this run was calculated;
 * - LATER month: its PAYE missed this run — this run, as it now stands, was
 *   not approved when that month was calculated — and, for some employee
 *   both runs pay from the tables, this run's line lacks a
 *   PAYE_LATER_PERIODS_APPROVED whose `periods` holds that month. Read off the
 *   lines, per employee and per month, as laterPeriodsWarnings writes it: only
 *   for the employees on the later month's lines at the time, listing the
 *   months, and only on a line taxed from the tables (whom it never warns
 *   need not carry it: a recalculation always clears the refusal; breaker
 *   round 1). "From the tables": periodic_taxable or
 *   annual_taxable > 0; on this run's line, before migration 913 (NULLs),
 *   taxable_income > 0 (a pre-cumulative line carries no warning: refused
 *   until recalculated); on the later month's, NULL = calculated before
 *   cumulative PAYE, which read no year-to-date, so missed nothing. A warning
 *   without `periods` (#786's dev/test lines; none in production) or a
 *   non-array validation_results reads as no warning: a conservative refusal
 *   a recalculation clears. Matched by containment, never on the message.
 * - LATER month calculated from an EARLIER VERSION of this run (this run was
 *   approved then — only a closed approval in approval_history can cover it —
 *   and its lines were rewritten since) that pays someone from the tables
 *   whom an earlier approved version taxed (approved_taxed_employees, the
 *   union over every closed approval; NULL = unknown, so anyone) and this run
 *   no longer pays from the tables: its year-to-date still counts this run's
 *   old line for them, and no warning can sit on a line this run does not
 *   have. The remedy is the LATER month: reopen it (no longer judged), approve
 *   this run, recalculate and approve it (reversing its journal first only if
 *   its figures change; approval says so). The union is conservative for
 *   someone taxed only in a version that month did not read (review round 2,
 *   breaker round 3).
 * Recalculating this run clears the first two (a calculation reads both
 * again). The earlier arm is per run: a refusal when no employee is shared is
 * conservative.
 *
 * "As it now stands": its lines were written (calculated) no later, and it was
 * approved then. "Approved at t": its current approval (`approved_at`, NULL =
 * before migration 718, so always) began by t, or t falls in an approval a
 * reopen ended (`approval_history`, migration 925). All of them, not just the
 * last reopen: a month reopened, re-approved and reopened again has a gap
 * before its last reopen, and a run calculated in it left the month out
 * (p4fu-r2-exact-gate, first case). A month whose lines were rewritten after
 * this run read them counts as missed, figures changed or not (refusing is
 * what a recalculation clears). A run reopened before 925 has no history: its
 * earlier approvals read as never, so a refusal there is conservative.
 *
 * Timing: "calculated" = the first line's created_at; every time compared is
 * clock_timestamp() (no NOW()). Approve, calculate and reopen all take
 * lockCompanyPayrollApprovals first, and a calculation holds it from its
 * year-to-date read to its commit, so no approval or reopen commits between
 * that read and its first line: the comparisons are exact (except (e)).
 *
 * NAMED LIMITS (tests: p4fu-r2-brk-employee-set, -older-version, -brk3-taxed-set):
 * (b) the gate does not look at how a run's PAYE was computed. A run
 * calculated before cumulative PAYE (lines without periodic_taxable) read no
 * year-to-date, yet the earlier arm judges it like any other: refused if an
 * earlier month was approved after it (conservative; a recalculation makes it
 * cumulative), otherwise approved with its ×12 PAYE, which the next
 * cumulative month trues up — not February. (a) A NULL approved_at counts as
 * approved all along; it is an approval from before migration 718, so a run
 * that missed it was calculated before 913 too: (b). (c) The warning stands
 * for any later month it names, also one calculated from this run's EARLIER
 * figures for an employee this run still taxes: once a recalculation (with
 * that month approved) puts the warning on the line, the gate passes,
 * although that month's PAYE counted the old figures.
 * (d) Only approved months are judged: a month reopened and left so (or
 * cancelled) is in no pair, and the months that read it keep counting PAYE it
 * no longer declares until it is approved again (that approval judges them).
 * (e) A caller with no outer transaction (a script) holds that lock only for
 * its own block: an approval or reopen inside the window can be misjudged.
 * (f) A PAID later
 * month (no code writes 'paid'; legacy rows) cannot be reopened, so the
 * earlier-version arm does not refuse for it: it keeps counting this run's
 * old figures for those employees, said in a non-blocking advisory
 * (`paye_paid_later_month_stale`, in the preview, not in the plan hash).
 *
 * Read-only; under the gate's company approval lock. Null when current.
 */
export async function judgeYearToDate(companyId: string, runId: string): Promise<YearToDateJudgement> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    WITH tax_year AS (
      SELECT make_date(CASE WHEN h.period_month >= ${PAYE_TAX_YEAR_START_MONTH} THEN h.period_year ELSE h.period_year - 1 END, ${PAYE_TAX_YEAR_START_MONTH}, 1) AS start
      FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
    ),
    runs AS (
      SELECT h.id, h.period_year, h.period_month, h.status, h.approved_at, h.approval_history, h.approved_taxed_employees,
             make_date(h.period_year, h.period_month, 1) AS period,
             (SELECT MIN(l.created_at) FROM payroll_run_lines l WHERE l.run_id = h.id) AS calculated_at
      FROM payroll_run_headers h, tax_year y
      WHERE h.company_id = ${companyId}::uuid
        AND make_date(h.period_year, h.period_month, 1) >= y.start
        AND make_date(h.period_year, h.period_month, 1) < (y.start + INTERVAL '1 year')
    ),
    me AS (SELECT r.* FROM runs r WHERE r.id = ${runId}::uuid),
    judged AS (
    SELECT e.period_year, e.period_month, e.period > me.period AS later,
      CASE
        WHEN e.period < me.period THEN NOT (
          e.calculated_at <= me.calculated_at
          AND (COALESCE(e.approved_at <= me.calculated_at, true) OR COALESCE(e.approval_history @> me.calculated_at, false)))
        ELSE NOT (
            me.calculated_at <= e.calculated_at
            AND ((me.status = ANY(${declarable}::text[]) AND COALESCE(me.approved_at <= e.calculated_at, true))
              OR COALESCE(me.approval_history @> e.calculated_at, false)))
          AND EXISTS (
            SELECT 1 FROM payroll_run_lines ml
            JOIN payroll_run_lines el ON el.run_id = e.id AND el.employee_id = ml.employee_id
            WHERE ml.run_id = me.id
              AND COALESCE(ml.periodic_taxable > 0 OR ml.annual_taxable > 0, ml.taxable_income > 0)
              AND COALESCE(el.periodic_taxable > 0 OR el.annual_taxable > 0, false)
              AND NOT ml.validation_results @> jsonb_build_array(jsonb_build_object(
                'code', 'PAYE_LATER_PERIODS_APPROVED', 'periods', jsonb_build_array(to_char(e.period, 'YYYY-MM')))))
      END AS recalc_here,
      -- A later month calculated from an earlier version of this run (approved then, lines since rewritten:
      -- only a closed approval can cover that time) that pays someone from the tables whom an earlier version
      -- taxed and this run no longer does. A paid month cannot be reopened: an advisory, not a refusal (limit (f)).
      e.period > me.period
        AND COALESCE(me.calculated_at, 'infinity'::timestamptz) > e.calculated_at -- no lines: rewritten after every month
        AND COALESCE(me.approval_history @> e.calculated_at, false)
        AND EXISTS (
          SELECT 1 FROM payroll_run_lines el
          WHERE el.run_id = e.id
            AND COALESCE(el.periodic_taxable > 0 OR el.annual_taxable > 0, false)
            AND el.employee_id = ANY(COALESCE(me.approved_taxed_employees, ARRAY[el.employee_id]))
            AND NOT EXISTS (
              SELECT 1 FROM payroll_run_lines ml
              WHERE ml.run_id = me.id AND ml.employee_id = el.employee_id
                AND COALESCE(ml.periodic_taxable > 0 OR ml.annual_taxable > 0, ml.taxable_income > 0)))
      AS older_dropped, e.status AS e_status
    FROM runs e, me
    WHERE e.id <> me.id
      AND e.status = ANY(${declarable}::text[])
    )
    SELECT period_year, period_month, later, recalc_here,
           older_dropped AND e_status <> 'paid' AS recalc_later, older_dropped AND e_status = 'paid' AS paid_old
    FROM judged WHERE recalc_here OR older_dropped
    ORDER BY period_year, period_month
  `) as DbRow[];
  if (rows.length === 0) return { blocker: null, advisories: [] };
  const month = (r: DbRow) => `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`;
  const here = rows.filter(r => r.recalc_here === true);
  const earlier = here.filter(r => r.later !== true).map(month);
  const later = here.filter(r => r.later === true).map(month);
  const fromOld = rows.filter(r => r.recalc_later === true).map(month);
  const paidOld = rows.filter(r => r.paid_old === true).map(month);
  const advisories: PayrollJournalNote[] = paidOld.length === 0 ? [] : [{
    code: 'paye_paid_later_month_stale',
    detail: `A later month of this tax year (${paidOld.join(', ')}) is paid and was calculated from this run's earlier figures for `
      + 'employees this run no longer pays from the tables, so its PAYE still counts them; a paid month cannot be reopened. '
      + 'The difference stays until those employees\' assessments unless corrected outside payroll.',
  }];
  const parts: string[] = [];
  if (earlier.length > 0) {
    parts.push(`An earlier month of this tax year (${earlier.join(', ')}) was not approved, as it now stands, when this run was `
      + 'calculated (approved since, reopened then, or recalculated since), so this run\'s cumulative PAYE left it out. '
      + 'Recalculate the run, then approve it.');
  } else if (later.length > 0) {
    parts.push(`A later month of this tax year (${later.join(', ')}) was calculated while this run was not approved as it now stands, `
      + 'so that month\'s cumulative PAYE left this one out, and this run\'s lines do not carry the warning that says so. '
      + 'Recalculate the run, then approve it.');
  }
  if (fromOld.length > 0) {
    parts.push(`A later month of this tax year (${fromOld.join(', ')}) was calculated from this run's earlier figures and pays `
      + 'employees from the tables whom this run no longer does, so its PAYE still counts what this run used to declare for them. '
      + 'Reopen that month, approve this run, then recalculate and approve that month (if its figures change, approval '
      + 'asks for its posted journal to be reversed first).');
  }
  return { blocker: parts.length === 0 ? null : { code: 'paye_year_to_date_stale', detail: parts.join(' ') }, advisories };
}

/** judgeYearToDate's blocker alone. */
export async function judgeYearToDateStale(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  return (await judgeYearToDate(companyId, runId)).blocker;
}
