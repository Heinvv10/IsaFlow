/**
 * An employee's medical scheme fees and medical tax credits over a span of a
 * tax year, from the lines of DECLARABLE runs (EMP201_DECLARABLE_STATUSES), as
 * the e@syFile certificate reports them (PAYE 4a follow-ups round 2, R3):
 * - fees: 4005, the medical scheme fees the employee paid through payroll, the
 *   lines' medical_scheme_fees (migration 926). A line written before it is
 *   NULL, and its fees are its stored breakdown's deductions coded 4005 (the
 *   component's type read from payroll_components, as the calculator counts
 *   them: componentType 'deduction');
 * - credit: 4116, the lines' medical_credit (payeCumulative: each line records
 *   the credit inside the liability to date less what earlier lines recorded,
 *   so the sum is the credit inside the latest line's liability);
 * - recorded: whether the employee's latest line taxed from the tables
 *   (taxable_income > 0) carries a record. If it does not (calculated before
 *   926), the sum misses that line's credit and its fees' credit, so the
 *   certificate cannot state 4116 (see easyFileMedicalFields).
 *
 * Named limit (legacy fees): a pre-926 line's fees are read from its stored
 * breakdown against TODAY's payroll_components; a 4005 component deleted since
 * counts nothing, and one retyped from or to 'deduction' counts by its new
 * type. Lines written from 926 on store the figure and are not affected.
 *
 * Every query is scoped by company_id (the run header; lines have none).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

export interface MedicalRecord {
  fees: number;
  credit: number;
  /** 4120: the lines' additional_medical_credit (the 65+ credit), recorded like `credit`. */
  additionalCredit: number;
  recorded: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** By employee id, over the declarable lines whose period is within [start, end]. */
export async function loadMedicalRecord(
  companyId: string,
  bounds: { start: string; end: string },
  employeeIds: string[] | null = null,
): Promise<Map<string, MedicalRecord>> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  // This scans each pre-926 line's breakdown again, beside loadPayeYearToDate's scan of the same lines
  // for 3605 and directive PAYE: deliberate, so the 4005 rule lives here alone (the certificate and the
  // year-to-date both read it); the scan only runs for lines whose medical_scheme_fees is NULL.
  const rows = (await sql`
    SELECT l.employee_id,
           SUM(COALESCE(l.medical_scheme_fees, (
             SELECT COALESCE(SUM((item->>'amount')::numeric), 0)
             FROM jsonb_array_elements(COALESCE(l.component_breakdown, '[]'::jsonb)) AS item
             JOIN payroll_components pc ON pc.id::text = item->>'componentId' AND pc.company_id = h.company_id
             WHERE pc.component_type = 'deduction'
               AND regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '4005'
           )))::numeric AS fees,
           SUM(l.medical_credit)::numeric AS credit,
           SUM(l.additional_medical_credit)::numeric AS additional_credit,
           (array_agg(l.medical_credit IS NOT NULL ORDER BY h.period_year DESC, h.period_month DESC)
              FILTER (WHERE l.taxable_income > 0))[1] AS latest_recorded
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    WHERE h.company_id = ${companyId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
      AND (${employeeIds}::uuid[] IS NULL OR l.employee_id = ANY(${employeeIds}::uuid[]))
    GROUP BY l.employee_id
  `) as DbRow[];
  return new Map(rows.map(r => [String(r.employee_id), {
    fees: round2(Number(r.fees)),
    credit: round2(Number(r.credit)),
    additionalCredit: round2(Number(r.additional_credit)),
    // No taxed line at all: nothing was taken off any tax, so nothing is missing.
    recorded: r.latest_recorded !== false,
  }]));
}
