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
 *   only at their directive's figures, outside the tables);
 * - medicalCredit: the medical scheme fees tax credit the lines recorded
 *   (medical_credit, migration 926; a line before it recorded none, so the
 *   next line's record carries its credit: payeCumulative).
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
      SELECT l.employee_id, l.paye, b.directive_paye, COALESCE(l.medical_credit, 0) AS medical_credit,
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
           SUM(paye - directive_paye)::numeric AS table_paye,
           SUM(medical_credit)::numeric AS medical_credit
    FROM split
    GROUP BY employee_id
  `) as DbRow[];
  return new Map(rows.map(r => [String(r.employee_id), {
    periods: Number(r.periods),
    periodicTaxable: round2(Number(r.periodic)),
    annualPayments: round2(Number(r.annual)),
    tablePaye: round2(Number(r.table_paye)),
    medicalCredit: round2(Number(r.medical_credit)),
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
  return new Map([...months].map(([employee, list]) => [employee, {
    code: 'PAYE_LATER_PERIODS_APPROVED',
    severity: 'warning' as const,
    message: `Later runs of this tax year that pay this employee are already approved (${list.join(', ')}). PAYE is cumulative over `
      + 'the year, so their PAYE did not include this month: the next run calculated after them corrects it. If February is '
      + 'among them, nothing follows and IsaFlow has no PAYE adjustment: the difference stays until the employee\'s assessment, '
      + 'unless those runs are reopened and recalculated in order.',
  }]));
}

/**
 * The approval-gate blocker for a run judged on a stale picture of its tax
 * year: another month of the same tax year was approved AFTER this run's
 * lines were calculated.
 * - An EARLIER month: this run's cumulative PAYE may have left it out (two
 *   months calculated before either was approved, or the earlier one reopened
 *   at the time). Recalculating picks it up. Conservative: a re-approval of an
 *   unchanged earlier month re-stamps approved_at (and lines_confirmed_at,
 *   updated_at), so it is refused too, though that run had seen it: the stored
 *   headers keep no reopen history to tell the two apart. One recalculation
 *   clears it; an exact rule needs a reopen-history column.
 * - A LATER month whose PAYE left this one out, while this run's lines do not
 *   yet carry PAYE_LATER_PERIODS_APPROVED (a calculation now adds it,
 *   laterPeriodsWarnings): for a run never approved before (no journal), a
 *   later month approved after this run was calculated; for a reopened run, a
 *   later month CALCULATED after this run's last change (its reopen or
 *   recalculation, `updated_at`), when this run was not declarable. A later
 *   month calculated before the reopen saw this run, so an unchanged
 *   re-approval passes. Recalculating puts the warning on the lines.
 *   (`updated_at` is NOW(), its transaction's start, and line times are
 *   clock_timestamp(): the skew can only make this fire early, a refusal a
 *   recalculation clears, never miss.)
 * Approvals of a company are serialised by lockCompanyPayrollApprovals, taken
 * before the gate, so a concurrent approval is either committed (and seen) or
 * waits. Null when current. Read-only. "Calculated" is the first line's clock
 * time, the nearest stored point to the year-to-date read; an approval
 * committed in the moments between that read and the first line insert is not
 * seen (a narrow race; the next month's calculation still trues it up).
 */
export async function judgeYearToDateStale(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    WITH me AS (
      SELECT h.period_year, h.period_month, h.journal_entry_id, h.updated_at,
             make_date(CASE WHEN h.period_month >= 3 THEN h.period_year ELSE h.period_year - 1 END, 3, 1) AS year_start,
             (SELECT MIN(l.created_at) FROM payroll_run_lines l WHERE l.run_id = h.id) AS calculated_at
      FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
    )
    SELECT e.period_year, e.period_month,
           make_date(e.period_year, e.period_month, 1) > make_date(me.period_year, me.period_month, 1) AS later
    FROM payroll_run_headers e, me
    WHERE e.company_id = ${companyId}::uuid AND e.id <> ${runId}::uuid
      AND e.status = ANY(${declarable}::text[])
      AND make_date(e.period_year, e.period_month, 1) >= me.year_start
      AND make_date(e.period_year, e.period_month, 1) < (me.year_start + INTERVAL '1 year')
      AND CASE
        WHEN make_date(e.period_year, e.period_month, 1) < make_date(me.period_year, me.period_month, 1)
          THEN e.approved_at > me.calculated_at
        WHEN me.journal_entry_id IS NULL THEN e.approved_at > me.calculated_at
        ELSE (SELECT MIN(l.created_at) FROM payroll_run_lines l WHERE l.run_id = e.id) > me.updated_at
      END
    ORDER BY e.period_year, e.period_month
  `) as DbRow[];
  if (rows.length === 0) return null;
  const month = (r: DbRow) => `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`;
  const earlier = rows.filter(r => r.later !== true).map(month);
  const later = rows.filter(r => r.later === true).map(month);
  return {
    code: 'paye_year_to_date_stale',
    detail: (earlier.length > 0
      ? `An earlier month of this tax year (${earlier.join(', ')}) was approved after this run was calculated, so this run's `
        + 'cumulative PAYE may have left it out (it was not approved, or was reopened, when this run was calculated; a '
        + 're-approval of an unchanged month looks the same). '
      : `A later month of this tax year (${later.join(', ')}) was approved after this run was calculated, so that month's `
        + 'cumulative PAYE left this one out. ')
      + 'Recalculate the run, then approve it.',
  };
}
