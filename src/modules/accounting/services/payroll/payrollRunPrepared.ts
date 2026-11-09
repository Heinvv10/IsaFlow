import { sql } from '@/lib/neon';
import { judgePayrollApproval } from './payrollApprovalGate';
import { recordPayRunApprovalAudit } from './payRunApprovalAudit';

/** Records the approval plan hash of a freshly calculated run, and its prepared audit event (moved out of payrollRunService.ts, unchanged). */
export async function recordPreparedApproval(companyId: string, runId: string, author: string | null): Promise<void> {
  const approval = await judgePayrollApproval(companyId, runId);
  if (!approval) throw new Error('Calculated payroll run disappeared before its approval plan was recorded');
  await sql`
    UPDATE payroll_run_headers SET approval_plan_hash = ${approval.planHash}
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;
  if (author) {
    await recordPayRunApprovalAudit({
      companyId, runId, actorId: author, event: 'prepared', planHash: approval.planHash,
    });
  }
}
