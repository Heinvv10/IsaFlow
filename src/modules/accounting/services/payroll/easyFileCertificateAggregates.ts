/**
 * The e@syFile certificate's per-employee totals over the tax year (a pure move out of pages/api/payroll/irp5/easyfile-export.ts):
 * the declarable run lines by employee, with the contractor months (PAYE_OUTSIDE_TABLES, treatment none) summed apart (easyFileContractor).
 * Every query is scoped by company_id (the run header).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { contractorLineFlag } from './payrollOutsideTables';

export function loadCertificateAggregates(
  companyId: string,
  declarableStatuses: string[],
  { startYear, startMonth, endYear, endMonth }: { startYear: number; startMonth: number; endYear: number; endMonth: number },
): Promise<DbRow[]> {
  return sql`
    SELECT
      prl.employee_id,
      SUM(prl.gross_pay)    AS total_gross,
      SUM(prl.paye)         AS total_paye,
      SUM(prl.uif_employee) AS total_uif_emp,
      SUM(prl.uif_employer) AS total_uif_empr,
      SUM(prl.sdl)          AS total_sdl,
      -- An independent contractor's months (PAYE_OUTSIDE_TABLES, treatment none) are code 3616, decided per line (easyFileContractor).
      COALESCE(SUM(prl.gross_pay) FILTER (WHERE COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)), 0) AS contractor_gross,
      -- Inside those lines: the taxable 3605 and the non-cash benefits, each floored at nil per line (the 3605 leaves the employee's 3605 and is
      -- 3616; the benefits are outside gross_pay, in 3616 and never 38xx), and the directive lump sums (39xx, filed as lump sums, out of 3616).
      COALESCE(SUM(GREATEST((
        SELECT COALESCE(SUM((item->>'amount')::numeric), 0)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array' THEN prl.component_breakdown ELSE '[]'::jsonb END) item
         WHERE regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3605' AND COALESCE((item->>'isTaxable')::boolean, false)
      ), 0)) FILTER (WHERE COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)), 0) AS contractor_annual,
      -- The directive lump sums are netted as listRunLumpSums nets them (a sum per employee, a reversal against its payment, NO per-line floor,
      -- and only a directive the company has), so what leaves 3616 is exactly what the lump-sum list files.
      COALESCE(SUM((
        SELECT COALESCE(SUM((item->>'amount')::numeric), 0)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array' THEN prl.component_breakdown ELSE '[]'::jsonb END) item
         WHERE item->'directive' IS NOT NULL
           AND EXISTS (SELECT 1 FROM tax_directives d WHERE d.id = (item->'directive'->>'id')::uuid AND d.company_id = prh.company_id)
      )) FILTER (WHERE COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)), 0) AS contractor_directive,
      COALESCE(SUM(GREATEST((
        SELECT COALESCE(SUM((item->>'amount')::numeric), 0)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array' THEN prl.component_breakdown ELSE '[]'::jsonb END) item
         WHERE item->>'isNonCash' = 'true'
      ), 0)) FILTER (WHERE COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)), 0) AS contractor_noncash
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    WHERE prh.company_id = ${companyId}::uuid
      AND prh.status = ANY(${declarableStatuses}::text[])
      AND (
        (prh.period_year = ${startYear} AND prh.period_month >= ${startMonth})
        OR
        (prh.period_year = ${endYear}   AND prh.period_month <= ${endMonth})
      )
    GROUP BY prl.employee_id
` as Promise<DbRow[]>;
}
