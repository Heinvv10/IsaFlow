/**
 * An employee's retirement fund contributions over a span of a tax year, from
 * the lines of DECLARABLE runs (EMP201_DECLARABLE_STATUSES): by code for the
 * e@syFile certificate's 4001 / 4003 / 4006 (PAYE 4c,
 * easyFileRetirementFields), and in total for the cumulative PAYE's year to
 * date (payrollYearToDate). One rule for both, so PAYE and the certificate
 * cannot disagree about what was contributed.
 *
 * Which breakdown items are contributions:
 * - a line from migration 948 on: the items the calculator marked
 *   `retirementContribution` (deductions coded 4001/4003/4006), read off the
 *   line itself; their sum is the line's retirement_contributions;
 * - a line before 948 (retirement_contributions NULL): items coded
 *   4001/4003/4006 whose component is a deduction, the type read from TODAY's
 *   payroll_components (as payrollMedicalRecord reads pre-926 fees). Named
 *   limit: a component deleted since counts nothing, one retyped counts by its
 *   new type. Such a line was taxed by the calculator before 4c: an item
 *   flagged taxable was deducted uncapped (already inside its
 *   periodic_taxable), one flagged non-taxable not at all. `legacyTaxable`
 *   says how much to add back to its periodic pay, and counts as the
 *   deduction it recorded.
 * Donations: items coded 4030 flagged taxable on a deduction (s18A), for the
 * s11F base, which is taken before them (G21 (2027) p. 10).
 *
 * Every query is scoped by company_id (the run header; lines have none).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { RETIREMENT_CONTRIBUTION_CODES } from './retirementFundCodes';
import type { RetirementContributions } from './easyFileRetirementFields';

export interface RetirementRecord extends RetirementContributions {
  /** All contributions (the line's retirement_contributions, else its breakdown). */
  contributions: number;
  /** The deduction the lines recorded (retirement_deduction, else a pre-948 line's taxable-flagged contributions). */
  deduction: number;
  /** Pre-948 lines' taxable-flagged contributions: already deducted from their periodic_taxable, to add back. */
  legacyTaxable: number;
  /** Donations (4030) deducted as taxable deductions. */
  donations: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const codes: string[] = [...RETIREMENT_CONTRIBUTION_CODES];

/** By employee id, over the declarable lines whose period is within [start, end]; an employee with none is absent. */
export async function loadRetirementRecord(
  companyId: string,
  bounds: { start: string; end: string },
  employeeIds: string[] | null = null,
): Promise<Map<string, RetirementRecord>> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    WITH line AS (
      SELECT l.employee_id, l.retirement_contributions, l.retirement_deduction, x.*
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(i.amount) FILTER (WHERE i.counted AND i.code = '4001'), 0) AS pension,
               COALESCE(SUM(i.amount) FILTER (WHERE i.counted AND i.code = '4003'), 0) AS provident,
               COALESCE(SUM(i.amount) FILTER (WHERE i.counted AND i.code = '4006'), 0) AS annuity,
               COALESCE(SUM(i.amount) FILTER (WHERE i.counted AND i.code = ANY(${codes}::text[])), 0) AS breakdown_all,
               COALESCE(SUM(i.amount) FILTER (WHERE i.counted AND i.code = ANY(${codes}::text[]) AND i.taxable), 0) AS breakdown_taxable,
               COALESCE(SUM(i.amount) FILTER (WHERE i.code = '4030' AND i.taxable AND i.deduction IS NOT FALSE), 0) AS donations
        FROM (
          SELECT regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS code,
                 (item->>'amount')::numeric AS amount,
                 COALESCE((item->>'isTaxable')::boolean, false) AS taxable,
                 pc.component_type = 'deduction' AS deduction,
                 CASE WHEN l.retirement_contributions IS NOT NULL THEN COALESCE((item->>'retirementContribution')::boolean, false)
                      ELSE COALESCE(pc.component_type = 'deduction', false) END AS counted
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array' THEN l.component_breakdown ELSE '[]'::jsonb END) AS item
          LEFT JOIN payroll_components pc ON pc.id::text = item->>'componentId' AND pc.company_id = h.company_id
        ) i
      ) x
      WHERE h.company_id = ${companyId}::uuid
        AND h.status = ANY(${declarable}::text[])
        AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
        AND (${employeeIds}::uuid[] IS NULL OR l.employee_id = ANY(${employeeIds}::uuid[]))
    )
    SELECT employee_id,
           SUM(pension)::numeric AS pension, SUM(provident)::numeric AS provident, SUM(annuity)::numeric AS annuity,
           SUM(COALESCE(retirement_contributions, breakdown_all))::numeric AS contributions,
           SUM(COALESCE(retirement_deduction, breakdown_taxable))::numeric AS deduction,
           COALESCE(SUM(breakdown_taxable) FILTER (WHERE retirement_contributions IS NULL), 0)::numeric AS legacy_taxable,
           SUM(donations)::numeric AS donations
    FROM line
    GROUP BY employee_id
  `) as DbRow[];
  return new Map(rows.map(r => [String(r.employee_id), {
    pension4001: round2(Number(r.pension)),
    provident4003: round2(Number(r.provident)),
    annuity4006: round2(Number(r.annuity)),
    contributions: round2(Number(r.contributions)),
    deduction: round2(Number(r.deduction)),
    legacyTaxable: round2(Number(r.legacy_taxable)),
    donations: round2(Number(r.donations)),
  }]));
}

/** The certificate's 4001 / 4003 / 4006 by employee (see loadRetirementRecord). */
export async function loadRetirementContributions(
  companyId: string,
  bounds: { start: string; end: string },
  employeeIds: string[] | null = null,
): Promise<Map<string, RetirementContributions>> {
  const record = await loadRetirementRecord(companyId, bounds, employeeIds);
  return new Map([...record].map(([id, r]) => [id, { pension4001: r.pension4001, provident4003: r.provident4003, annuity4006: r.annuity4006 }]));
}
