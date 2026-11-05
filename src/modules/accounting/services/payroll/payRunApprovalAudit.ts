import { logAuditOrThrow, type AuditAction } from '../core/auditTrailService';

export type PayRunApprovalEvent =
  | 'prepared' | 'requested' | 'authorised' | 'declined' | 'executed' | 'reopened' | 'reversed';

/** Historical 951 rows have no trustworthy reviewed hash; record that fact instead of omitting their event. */
export const GRANDFATHERED_PLAN_HASH = 'grandfathered-plan-hash-unavailable';

const ACTION: Record<PayRunApprovalEvent, AuditAction> = {
  prepared: 'update', requested: 'update', authorised: 'approve', declined: 'reject',
  executed: 'post', reopened: 'update', reversed: 'reverse',
};

export async function recordPayRunApprovalAudit(input: {
  companyId: string;
  runId: string;
  actorId: string;
  event: PayRunApprovalEvent;
  planHash: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  await logAuditOrThrow({
    companyId: input.companyId,
    userId: input.actorId,
    action: ACTION[input.event],
    entityType: 'payroll_run',
    entityId: input.runId,
    changes: {
      fields: [{ field: 'approval_event', old: null, new: input.event, label: 'Payroll approval event' }],
      metadata: { event: input.event, planHash: input.planHash, ...input.metadata },
    },
  });
}
