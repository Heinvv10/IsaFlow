/**
 * An employee's earlier periods of the tax year, for the cumulative PAYE
 * (payeCumulative.ts; PAYE 4a follow-ups G4).
 *
 * From the employee's lines on DECLARABLE runs (EMP201_DECLARABLE_STATUSES:
 * approved, paid) of the same SA tax year (March to February) whose period is
 * BEFORE the run being calculated, so the run itself, a reopened run (no longer
 * declarable) and any later period are never in it. Lines are what the
 * employee was paid and what EMP201 and the IRP5 declare, so the cumulative
 * deduction trues up to exactly those.
 *
 * - periods: lines with periodic pay (a severance-only line has none);
 * - periodicTaxable / annualPayments: the line's periodic_taxable /
 *   annual_taxable (migration 913). A line written before 913 has NULLs, and
 *   its split is derived from the stored breakdown: annual payments = its
 *   taxable 3605 items, netted and floored at nil, capped at taxable_income;
 *   periodic = taxable_income less that;
 * - tablePaye: the line's PAYE less its directive PAYE (lump sums are taxed
 *   only at their directive's figures, outside the tables).
 *
 * Every query is scoped by company_id.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { getTaxYear } from './taxTables';
import type { PayeYearToDate, PayrollPeriod, ValidationResult } from './payrollTypes';
import type { PayrollJournalNote } from './payrollJournalBuilder';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** By employee id; an employee with no earlier line this tax year is absent (none to date). */
export async function loadPayeYearToDate(
  companyId: string,
  runId: string,
  period: PayrollPeriod,
  employeeIds: string[],
): Promise<Map<string, PayeYearToDate>> {
  if (employeeIds.length === 0) return new Map();
  const taxYear = getTaxYear(period.month, period.year);
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    WITH split AS (
      SELECT l.employee_id, l.paye, b.directive_paye,
             COALESCE(l.annual_taxable, LEAST(b.annual_3605, l.taxable_income)) AS annual,
             COALESCE(l.periodic_taxable, l.taxable_income - LEAST(b.annual_3605, l.taxable_income)) AS periodic
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM((item->'directive'->>'paye')::numeric) FILTER (WHERE item->'directive' IS NOT NULL), 0) AS directive_paye,
               GREATEST(COALESCE(SUM((item->>'amount')::numeric) FILTER (
                 WHERE regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3605'
                   AND (item->>'isTaxable')::boolean), 0), 0) AS annual_3605
        FROM jsonb_array_elements(l.component_breakdown) AS item
      ) b
      WHERE h.company_id = ${companyId}::uuid
        AND h.id <> ${runId}::uuid
        AND h.status = ANY(${declarable}::text[])
        AND make_date(h.period_year, h.period_month, 1) >= make_date(${taxYear - 1}::int, 3, 1)
        AND make_date(h.period_year, h.period_month, 1) < make_date(${period.year}::int, ${period.month}::int, 1)
        AND l.employee_id = ANY(${employeeIds}::uuid[])
    )
    SELECT employee_id,
           COUNT(*) FILTER (WHERE periodic > 0)::int AS periods,
           SUM(periodic)::numeric AS periodic,
           SUM(annual)::numeric AS annual,
           SUM(paye - directive_paye)::numeric AS table_paye
    FROM split
    GROUP BY employee_id
  `) as DbRow[];
  return new Map(rows.map(r => [String(r.employee_id), {
    periods: Number(r.periods),
    periodicTaxable: round2(Number(r.periodic)),
    annualPayments: round2(Number(r.annual)),
    tablePaye: round2(Number(r.table_paye)),
  }]));
}

/**
 * The warnings for a run calculated while LATER periods of its tax year are
 * already approved or paid (a month back-filled, or reopened and corrected),
 * by employee: only an employee paid in those later runs, whose PAYE there was
 * calculated without this month. The cumulative method trues it up only in the
 * next period calculated after them; if February is among them, nothing does
 * (IsaFlow has no PAYE adjustment), so it stays short until the assessment.
 */
export async function laterPeriodsWarnings(
  companyId: string,
  runId: string,
  period: PayrollPeriod,
): Promise<Map<string, ValidationResult>> {
  const taxYear = getTaxYear(period.month, period.year);
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id, h.period_year, h.period_month
    FROM payroll_run_headers h
    JOIN payroll_run_lines l ON l.run_id = h.id
    WHERE h.company_id = ${companyId}::uuid AND h.id <> ${runId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) > make_date(${period.year}::int, ${period.month}::int, 1)
      AND make_date(h.period_year, h.period_month, 1) <= make_date(${taxYear}::int, 2, 1)
    ORDER BY l.employee_id, h.period_year, h.period_month
  `) as DbRow[];
  const months = new Map<string, string[]>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const list = months.get(key) ?? [];
    list.push(`${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`);
    months.set(key, list);
  }
  // `periods` is what judgeYearToDateStale matches on; the message is for people.
  return new Map([...months].map(([employee, list]) => [employee, {
    code: 'PAYE_LATER_PERIODS_APPROVED',
    severity: 'warning' as const,
    periods: list,
    message: `Later runs of this tax year that pay this employee are already approved (${list.join(', ')}). PAYE is cumulative over `
      + 'the year, so their PAYE did not include this month: the next run calculated after them corrects it. If February is '
      + 'among them, nothing follows and IsaFlow has no PAYE adjustment: the difference stays until the employee\'s assessment, '
      + 'unless those runs are reopened and recalculated in order.',
  }]));
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
 *   months, and only on a line taxed from the tables (an employee it would never warn is
 *   never required to carry it, so a recalculation always clears the
 *   refusal; breaker round 1). "From the tables": periodic_taxable or
 *   annual_taxable > 0; on this run's line, before migration 913 (NULLs),
 *   taxable_income > 0 (a pre-cumulative line carries no warning: refused
 *   until recalculated); on the later month's, NULL = calculated before
 *   cumulative PAYE, which read no year-to-date, so missed nothing. A warning
 *   without `periods` (dev/test lines written by #786 before the field; none
 *   in production, where #786 was not deployed before it) or a validation_results
 *   that is not an array reads as no warning: a conservative refusal that a
 *   recalculation clears. Matched by containment, never on the message text.
 * - LATER month calculated from an EARLIER VERSION of this run (this run was
 *   approved then — only a closed approval in approval_history can cover it —
 *   and its lines were rewritten since) that pays someone from the tables
 *   whom this run no longer pays from the tables: its year-to-date still
 *   counts this run's old line for them, and no warning can sit on a line
 *   this run does not have. The remedy is the LATER month: reopen it (no
 *   longer judged), approve this run, recalculate and approve it. Conservative
 *   where the old version did not pay them either (a starter in the later
 *   month): reopening and recalculating it changes nothing (review round 2).
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
 * Timing. "Calculated" is the run's first line's created_at. approved_at,
 * reopened_at and the history bounds are clock_timestamp(), as line created_at
 * is: no NOW() (a transaction's start) is compared any more. Approve,
 * calculate and reopen all take lockCompanyPayrollApprovals first, and a
 * calculation holds it from before its year-to-date read until it commits, so
 * no approval or reopen of the company commits between that read and the
 * first line: each one's clock time is before the read or after the lines,
 * and the comparison is exact. A caller with no outer transaction (a script)
 * holds that lock only for its own block; there an approval or a reopen
 * committed inside the window can be misjudged.
 *
 * NAMED LIMITS (tests: p4fu-r2-brk-employee-set, p4fu-r2-older-version):
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
 * although that month's PAYE counted the old figures. The warning says the
 * month "did not include this month"; it included an older version of it.
 * (d) Only approved months are judged: a month reopened and left so (or
 * cancelled) is in no pair, and the months that read it keep counting PAYE it
 * no longer declares until it is approved again (that approval judges them).
 * (e) A caller with no outer transaction (Timing, above).
 *
 * Read-only; under the gate's company approval lock. Null when current.
 */
export async function judgeYearToDateStale(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    WITH tax_year AS (
      SELECT make_date(CASE WHEN h.period_month >= 3 THEN h.period_year ELSE h.period_year - 1 END, 3, 1) AS start
      FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
    ),
    runs AS (
      SELECT h.id, h.period_year, h.period_month, h.status, h.approved_at, h.approval_history,
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
      -- only a closed approval can cover that time) that pays someone from the tables whom this run no longer does.
      e.period > me.period
        AND me.calculated_at > e.calculated_at
        AND COALESCE(me.approval_history @> e.calculated_at, false)
        AND EXISTS (
          SELECT 1 FROM payroll_run_lines el
          WHERE el.run_id = e.id
            AND COALESCE(el.periodic_taxable > 0 OR el.annual_taxable > 0, false)
            AND NOT EXISTS (
              SELECT 1 FROM payroll_run_lines ml
              WHERE ml.run_id = me.id AND ml.employee_id = el.employee_id
                AND COALESCE(ml.periodic_taxable > 0 OR ml.annual_taxable > 0, ml.taxable_income > 0)))
      AS recalc_later
    FROM runs e, me
    WHERE e.id <> me.id
      AND e.status = ANY(${declarable}::text[])
    )
    SELECT * FROM judged WHERE recalc_here OR recalc_later
    ORDER BY period_year, period_month
  `) as DbRow[];
  if (rows.length === 0) return null;
  const month = (r: DbRow) => `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`;
  const here = rows.filter(r => r.recalc_here === true);
  const earlier = here.filter(r => r.later !== true).map(month);
  const later = here.filter(r => r.later === true).map(month);
  const fromOld = rows.filter(r => r.recalc_later === true).map(month);
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
      + 'Reopen that month, approve this run, then recalculate and approve that month.');
  }
  return { code: 'paye_year_to_date_stale', detail: parts.join(' ') };
}
