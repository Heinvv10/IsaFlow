/**
 * Who DECIDED a pay run's approval, as against who executed it (R-035).
 *
 * The approval request (approval_requests) holds the requester and the decider; POST /approve only executes what
 * was decided, and the header's `approved_by` now records the decider (the executor stays in the 'executed'
 * audit event). When the decider is also the requester the approval went through the sole-approver fallback
 * (decision Q2: nobody else could approve, so the ban on approving your own request yields; isSoleApproverApproval).
 * That is reported on the run (`selfApprovedSoleApprover`) and recorded in the audit trail, so a company can see its
 * payroll was approved by the person who raised it, and a run's preparer who also decided it (`preparedByDecider`)
 * is visible.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { approvedRequestsFor } from '../gl/approvalGate';
import { isSoleApproverApproval } from '../gl/approvalSelfApproval';
import type { PayRunDecisionSummary } from '../../types/payRunDecision.types';

export interface PayRunDecision {
  requestId: string;
  requestedBy: string;
  decidedBy: string;
  /** The decider raised the request themselves: approved through the sole-approver fallback. */
  selfApprovedSoleApprover: boolean;
}

/**
 * The approved request that cleared exactly `planHash` (its document digest), from the approvals the gate itself
 * clears on (approvalGate#approvedRequestsFor). Null when none (a grandfathered run, or enforcement off).
 */
export async function readPayRunDecision(companyId: string, runId: string, planHash: string): Promise<PayRunDecision | null> {
  const approved = await approvedRequestsFor(companyId, 'pay_run', runId);
  const match = approved.find((r) => r.documentDigest === planHash && r.decidedBy !== null);
  if (!match || match.decidedBy === null) return null;
  return {
    requestId: match.id, requestedBy: match.requestedBy, decidedBy: match.decidedBy,
    selfApprovedSoleApprover: isSoleApproverApproval(match),
  };
}

/**
 * The decision behind an approved or paid run, for the run API. `status` is the run's, read by the caller. Null for a
 * run that is not approved, one grandfathered by migration 951 (no reviewed hash, so no request), or one whose
 * approval request cannot be found. One header read: the hash that names the request, and who prepared the run.
 */
export async function describePayRunDecision(
  companyId: string,
  runId: string,
  status: string,
): Promise<PayRunDecisionSummary | null> {
  if (status !== 'approved' && status !== 'paid') return null;
  const header = ((await sql`
    SELECT approved_plan_hash, prepared_by::text AS prepared_by, approval_grandfathered_at
    FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!header || header.approval_grandfathered_at != null || header.approved_plan_hash == null) return null;
  const decision = await readPayRunDecision(companyId, runId, String(header.approved_plan_hash));
  if (!decision) return null;
  const preparedBy = header.prepared_by == null ? null : String(header.prepared_by);
  return {
    selfApprovedSoleApprover: decision.selfApprovedSoleApprover,
    preparedByDecider: preparedBy !== null && preparedBy === decision.decidedBy,
  };
}
