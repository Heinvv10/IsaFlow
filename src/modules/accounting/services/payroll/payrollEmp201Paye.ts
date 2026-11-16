/**
 * The EMP201 PAYE of each month of a PAYE tax year, from the declarable run headers (wave 6 FQb1). Summed over every
 * run of the month: the EMP501 reconciliation and the year-end checklist each kept one header per month in a Map keyed
 * by month, so a second run of the month replaced the first.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { PAYE_TAX_YEAR_END_MONTH, PAYE_TAX_YEAR_START_MONTH } from '@/modules/accounting/utils/payeTaxYear';

/** One row per month with a declarable run: period_year, period_month, emp201_paye (the month's runs summed). */
async function emp201PayeRows(companyId: string, taxYear: number): Promise<DbRow[]> {
  const declarableStatuses: string[] = [...EMP201_DECLARABLE_STATUSES];
  return (await sql`
    SELECT period_month, period_year, SUM(COALESCE(total_paye, 0))::float8 AS emp201_paye
    FROM   payroll_run_headers
    WHERE  company_id = ${companyId}::uuid
      AND  status = ANY(${declarableStatuses}::text[])
      AND (
        (period_year = ${taxYear - 1} AND period_month >= ${PAYE_TAX_YEAR_START_MONTH})
        OR
        (period_year = ${taxYear} AND period_month <= ${PAYE_TAX_YEAR_END_MONTH})
      )
    GROUP BY period_year, period_month
    ORDER BY period_year, period_month
  `) as DbRow[];
}

/** emp201PayeRows keyed `${year}-${month}` (no padding, as the EMP501 reconciliation keys its months). */
export async function emp201PayeByMonth(companyId: string, taxYear: number): Promise<Map<string, number>> {
  return new Map((await emp201PayeRows(companyId, taxYear)).map((r) => [`${r.period_year}-${r.period_month}`, Number(r.emp201_paye)]));
}
