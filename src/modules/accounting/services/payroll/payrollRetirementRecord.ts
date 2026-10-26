/**
 * An employee's retirement fund contributions over a span of a tax year, by
 * code, from the lines of DECLARABLE runs (EMP201_DECLARABLE_STATUSES), for
 * the e@syFile certificate's 4001 / 4003 / 4006 (PAYE 4c,
 * easyFileRetirementFields). The contributions are the lines' stored
 * breakdown items coded 4001, 4003 or 4006 whose component is a deduction (the
 * component's type read from payroll_components, as the calculator counts
 * them: componentType 'deduction'), so they are exactly what the PAYE counted.
 *
 * Named limit (as payrollMedicalRecord's legacy fees): the type is TODAY's
 * payroll_components row; a component deleted since counts nothing, one
 * retyped counts by its new type.
 *
 * Every query is scoped by company_id (the run header; lines have none).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import type { RetirementContributions } from './easyFileRetirementFields';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** By employee id, over the declarable lines whose period is within [start, end]; an employee with none is absent. */
export async function loadRetirementContributions(
  companyId: string,
  bounds: { start: string; end: string },
  employeeIds: string[] | null = null,
): Promise<Map<string, RetirementContributions>> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id,
           SUM(c.amount) FILTER (WHERE c.code = '4001')::numeric AS pension,
           SUM(c.amount) FILTER (WHERE c.code = '4003')::numeric AS provident,
           SUM(c.amount) FILTER (WHERE c.code = '4006')::numeric AS annuity
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    CROSS JOIN LATERAL (
      SELECT regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS code,
             (item->>'amount')::numeric AS amount
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array' THEN l.component_breakdown ELSE '[]'::jsonb END) AS item
      JOIN payroll_components pc ON pc.id::text = item->>'componentId' AND pc.company_id = h.company_id
      WHERE pc.component_type = 'deduction'
    ) c
    WHERE h.company_id = ${companyId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
      AND (${employeeIds}::uuid[] IS NULL OR l.employee_id = ANY(${employeeIds}::uuid[]))
      AND c.code IN ('4001', '4003', '4006')
    GROUP BY l.employee_id
  `) as DbRow[];
  return new Map(rows.map(r => [String(r.employee_id), {
    pension4001: round2(Number(r.pension ?? 0)),
    provident4003: round2(Number(r.provident ?? 0)),
    annuity4006: round2(Number(r.annuity ?? 0)),
  }]));
}
