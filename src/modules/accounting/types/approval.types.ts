/**
 * The derived approval state of a document (R-035, decision Q3), as the
 * approval gate computes it (gl/approvalGate.describeApprovalGate) and the
 * detail pages show it. Client-safe: types only.
 */

/** not_required: enforcement off or no rule governs; the others mirror the gate's refusals. */
export type ApprovalState = 'not_required' | 'required' | 'pending' | 'approved' | 'stale';

export interface DocumentApprovalState {
  state: ApprovalState;
  enforced: boolean;
  /** The role today's strictest matching rule demands. */
  requiredRole: string | null;
  ruleName: string | null;
  /** The pending request, the approval that cleared (or went stale), or null. */
  requestId: string | null;
}
