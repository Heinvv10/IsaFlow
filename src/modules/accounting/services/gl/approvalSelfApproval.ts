/**
 * Sole-approver self-approval (R-035, Hein's decision Q2, 2026-09-26).
 *
 * K-043 bans approving your own request. Once approvals are enforced on
 * posting paths that ban would leave a company whose only holder of the
 * demanded rank is the requester unable to post at all, so the ban now yields
 * in exactly that case: when no OTHER active member of the company holds the
 * demanded rank. assertMayDecide decides; this module supplies the roster and
 * records the outcome distinctly.
 */

import { sql } from '@/lib/neon';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { logAuditOrThrow } from '../core/auditTrailService';

/** Returned by assertMayDecide when the decision is a sole-approver self-approval. */
export interface SoleApproverSelfApproval {
  selfApproval: 'sole_approver';
  /** The ratcheted role the request demanded, which nobody else holds. */
  requiredRole: string;
}

/**
 * Company roles of every OTHER member in good standing.
 *
 * Read through `approval_company_other_members` (migration 708, SECURITY
 * DEFINER): under withAuth this runs as app_user, which sees only its own
 * `users` row, so a direct query would find nobody else and allow every
 * self-approval. The function answers only for the request asking (the JWT
 * subject and withAuth's company GUC), and RAISES when it cannot see the
 * caller's own membership, so an RLS-blinded read fails the decide instead of
 * clearing it. It therefore works only inside withAuth's transaction.
 */
export async function otherActiveMemberRoles(companyId: string, userId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT role, is_active, status, suspended_at
    FROM approval_company_other_members(${companyId}::UUID, ${userId}::TEXT)
  `) as { role: string; is_active: boolean | null; status: string | null; suspended_at: Date | string | null }[];
  return rows.filter((row) => isActiveUserAccount(row)).map((row) => String(row.role));
}

/**
 * The distinct marker: an `approve` audit row on the request whose metadata
 * says it was the requester's own, allowed because nobody else could. Written
 * with logAuditOrThrow — an unrecorded self-approval must not stand.
 */
export async function auditSoleApproverSelfApproval(
  companyId: string,
  userId: string,
  request: Record<string, unknown>,
  approval: SoleApproverSelfApproval,
): Promise<void> {
  await logAuditOrThrow({
    companyId,
    userId,
    action: 'approve',
    entityType: 'approval_request',
    entityId: String(request.id),
    entityRef: request.document_reference != null ? String(request.document_reference) : undefined,
    changes: {
      fields: [],
      metadata: {
        selfApproval: approval.selfApproval,
        requiredRole: approval.requiredRole,
        documentType: String(request.document_type),
        documentId: String(request.document_id),
        ...(request.document_digest != null ? { documentDigest: String(request.document_digest) } : {}),
      },
    },
  });
}
