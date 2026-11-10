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
      -- The taxable 3605 inside those lines stays 3605, not 3616.
      COALESCE(SUM((
        SELECT COALESCE(SUM((item->>'amount')::numeric), 0)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array' THEN prl.component_breakdown ELSE '[]'::jsonb END) item
         WHERE regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3605' AND COALESCE((item->>'isTaxable')::boolean, false)
      )) FILTER (WHERE COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)), 0) AS contractor_annual
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
