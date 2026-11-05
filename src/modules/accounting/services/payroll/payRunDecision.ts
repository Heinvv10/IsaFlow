/**
 * Who DECIDED a pay run's approval, as against who executed it (R-035).
 *
 * The approval request (approval_requests) holds the requester and the decider; POST /approve only executes what
 * was decided, and the header's `approved_by` now records the decider (the executor stays in the 'executed'
 * audit event). When the decider is also the requester the approval went through the sole-approver fallback
 * (decision Q2: nobody else could approve, so the ban on approving your own request yields; the only way
 * `requested_by = decided_by` is possible on an approved request). That is reported on the run
 * (`selfApprovedSoleApprover`) and recorded in the audit trail, so a company can see its payroll was approved by
 * the person who raised it, and a run's preparer who also decided it (`preparedByDecider`) is visible.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface PayRunDecision {
  requestId: string;
  requestedBy: string;
  decidedBy: string;
  /** The decider raised the request themselves: approved through the sole-approver fallback. */
  selfApprovedSoleApprover: boolean;
}

/**
 * The approved request that cleared exactly `planHash` (its document digest), among those decided since
 * enforcement was last switched on: the same selection the gate clears on (approvalGate#gateOutcome).
 * Null when none (a grandfathered run, or enforcement off).
 */
export async function readPayRunDecision(companyId: string, runId: string, planHash: string): Promise<PayRunDecision | null> {
  const row = ((await sql`
    SELECT ar.id::text AS id, ar.requested_by::text AS requested_by, ar.decided_by::text AS decided_by
    FROM approval_requests ar
    JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
    WHERE ar.company_id = ${companyId}::uuid AND ar.document_type = 'pay_run'
      AND ar.document_id = ${runId}::uuid AND ar.status = 'approved'
      AND ar.document_digest = ${planHash} AND ar.decided_at >= ae.enabled_at
      AND ar.decided_by IS NOT NULL
    ORDER BY ar.decided_at DESC NULLS LAST, ar.id
    LIMIT 1
  `) as DbRow[])[0];
  if (!row) return null;
  const requestedBy = String(row.requested_by);
  const decidedBy = String(row.decided_by);
  return { requestId: String(row.id), requestedBy, decidedBy, selfApprovedSoleApprover: requestedBy === decidedBy };
}

export interface PayRunDecisionView extends PayRunDecision {
  preparedBy: string | null;
  /** The person who calculated the run also decided its approval. */
  preparedByDecider: boolean;
}

/**
 * The decision behind an approved or paid run, for the run API. Null for a run that is not approved, one
 * grandfathered by migration 951 (no reviewed hash, so no request), or one whose approval request cannot be found.
 */
export async function describePayRunDecision(companyId: string, runId: string): Promise<PayRunDecisionView | null> {
  const header = ((await sql`
    SELECT status, approved_plan_hash, prepared_by::text AS prepared_by, approval_grandfathered_at
    FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!header || (header.status !== 'approved' && header.status !== 'paid')) return null;
  if (header.approval_grandfathered_at != null || header.approved_plan_hash == null) return null;
  const decision = await readPayRunDecision(companyId, runId, String(header.approved_plan_hash));
  if (!decision) return null;
  const preparedBy = header.prepared_by == null ? null : String(header.prepared_by);
  return { ...decision, preparedBy, preparedByDecider: preparedBy !== null && preparedBy === decision.decidedBy };
}
