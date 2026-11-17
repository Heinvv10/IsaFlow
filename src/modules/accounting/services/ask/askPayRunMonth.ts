/** "Ask IsaFlow": what else a pay run's month holds (wave 6 FQb2). */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';

/**
 * The month's OTHER final runs (wave 6 FQb2, review #1549 L4): an off-cycle bonus beside the regular run is declared
 * too, so the answer names it rather than passing one run off as the month's pay.
 */
export async function otherFinalRuns(companyId: string, runId: string, year: number, month: number): Promise<{ count: number; gross: number }> {
  const [row] = (await sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(h.total_gross), 0) AS gross FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::UUID AND ${sql.unsafe(payRunFinalSql('h'))}
       AND h.period_year = ${year}::INT AND h.period_month = ${month}::INT AND h.id <> ${runId}::UUID
  `) as DbRow[];
  return { count: Number(row?.n) || 0, gross: Number(row?.gross) || 0 };
}
