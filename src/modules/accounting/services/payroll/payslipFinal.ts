/**
 * Whether a pay run's payslips are final (wave 5 FS). Final = the run is `approved` or `paid` and
 * carries an approval time: `COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL`.
 * `approvePayrollRun` sets `approved_at` in the same UPDATE as the status (after the R-035 guard
 * cleared the run), reopen clears `approved_at` and `approval_grandfathered_at` in its UPDATE, and
 * migration 951 grandfathered the older runs. So the answer never depends on today's enforcement
 * or rules (the wave-4 limit: a run approved while enforcement was off turned DRAFT when it was
 * switched on), and an approved row with neither column is DRAFT, as before.
 *
 * Not a column of its own: code running on the other blue/green colour, or after a code-only
 * rollback, approves through the same two columns and so stays correct.
 * A failed read is a thrown error (a 500), never a slip that silently says DRAFT.
 */
import { sql } from '@/lib/neon';

export async function isPayRunFinal(companyId: string, runId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
       AND status IN ('approved', 'paid') AND COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL
  `) as unknown[];
  return rows.length > 0;
}
