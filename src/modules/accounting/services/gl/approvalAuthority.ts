/**
 * Company-scoped guards for the approval workflow.
 * Two invariants the decide path has to hold: the person who raised a request
 * may never decide it, and the decider must hold the role the matched
 * approval rule demands. Both are checked against the database, company-scoped,
 * never against anything the caller supplied.
 */

import { sql } from '@/lib/neon';

export type ApprovalDecisionErrorCode = 'SELF_APPROVAL_FORBIDDEN' | 'APPROVER_ROLE_REQUIRED';

export class ApprovalDecisionError extends Error {
  readonly code: ApprovalDecisionErrorCode;

  constructor(code: ApprovalDecisionErrorCode, message: string) {
    super(message);
    this.name = 'ApprovalDecisionError';
    this.code = code;
  }
}

/** The named rule does not belong to this company (or does not exist at all). */
export class ApprovalRuleNotFoundError extends Error {
  constructor(ruleId: string) {
    super(`Approval rule ${ruleId} not found for this company`);
    this.name = 'ApprovalRuleNotFoundError';
  }
}

/**
 * No active rule of this company governs the document, so there is nothing to
 * approve. Raised because the rule is resolved server-side now: the caller can
 * no longer nominate one, so "which rule?" has an answer or the request is not
 * a request.
 */
export class ApprovalNotRequiredError extends Error {
  constructor(documentType: string, documentId: string) {
    super(`No active approval rule requires approval for ${documentType} ${documentId}`);
    this.name = 'ApprovalNotRequiredError';
  }
}

/** The request is gone, belongs elsewhere, or someone else already decided it. */
export class ApprovalRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`Approval request ${requestId} not found or already decided`);
    this.name = 'ApprovalRequestNotFoundError';
  }
}

// Rank ladder for approver authority. ROLE_HIERARCHY in @/lib/auth/types has no
// entry for 'accountant', 'bookkeeper' or 'user', and its `?? 0` fallback would
// let anybody satisfy a rule whose approver_role is 'accountant' — one of the
// defaults seeded by migration 234. The roles a company can actually hold come
// from two allowlists: ALLOWED_COMPANY_ROLES in adminUserActionsService and the
// invitation route's own list. Every one of them must appear here, or the person
// holding it can never approve anything.
// tests/unit/services/gl/approverRankLadder.test.ts locks this ladder's ordering
// against ROLE_HIERARCHY and its coverage against both allowlists.
export const APPROVER_RANK: Record<string, number> = {
  super_admin: 8,
  owner: 7,
  system: 6,
  admin: 5,
  manager: 4,
  accountant: 3,
  bookkeeper: 2,
  storeman: 1,
  technician: 1,
  user: 1,
  viewer: 0,
};

/** Roles a rule may demand. Anything else is a typo that would silently mean admin. */
export const APPROVER_ROLES = Object.keys(APPROVER_RANK);
export const isApproverRole = (value: unknown): value is string =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(APPROVER_RANK, value);

// Both helpers go through isApproverRole rather than indexing and falling back on
// `??`: APPROVER_RANK is a plain object, so APPROVER_RANK['toString'] is a
// function, not undefined, and neither fallback would fire — the comparison
// would then be NaN < NaN, which is false, and the decision would be allowed.

/**
 * An unrecognised rule role falls back to 'admin', the column default in 234.
 * Exported because approvalRuleGuards ranks the same two things when deciding
 * who may EDIT a rule — one ladder, not a second copy that can drift.
 */
export const requiredRank = (role: string): number =>
  isApproverRole(role) ? APPROVER_RANK[role]! : APPROVER_RANK.admin!;

/** An unrecognised actor role carries no authority. */
export const actorRank = (role: string): number =>
  isApproverRole(role) ? APPROVER_RANK[role]! : 0;

/**
 * Throws ApprovalDecisionError when `decidedBy` may not take `decision` on
 * `requestId`. Silent when the request does not exist or is already decided —
 * the caller's status-predicated UPDATE reports that case.
 *
 * `decision` is required rather than defaulted: only `approve` is the controlled
 * act, and a caller that forgets to say which one it is must not silently get
 * the permissive answer.
 */
export async function assertMayDecide(
  companyId: string,
  requestId: string,
  decidedBy: string,
  decision: 'approved' | 'rejected'
): Promise<void> {
  const rows = (await sql`
    SELECT (ar.requested_by::TEXT = ${decidedBy}) AS is_self,
           ar.rule_id,
           ar.required_role,
           rl.id AS resolved_rule_id,
           rl.approver_role,
           cu.role AS decider_role
    FROM approval_requests ar
    LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ${companyId}
    LEFT JOIN company_users cu ON cu.company_id = ${companyId} AND cu.user_id = ${decidedBy}
    WHERE ar.id = ${requestId}::UUID AND ar.company_id = ${companyId} AND ar.status = 'pending'
  `) as Record<string, unknown>[];

  const row = rows[0];
  if (!row) return;

  if (row.is_self === true) {
    // Rejecting your OWN request is a withdrawal, not a separation-of-duties
    // breach: it grants nothing and closes the row. Allowing it is what makes a
    // request escapable when the ratchet's snapshot demands a rank only the
    // requester holds (a sole owner, say) — before this, such a row could be
    // neither approved nor rejected by anybody, and there is no cancel action.
    // The rank check below is skipped with it, for the same reason: a withdrawal
    // needs no approver authority.
    if (decision === 'rejected') return;
    throw new ApprovalDecisionError(
      'SELF_APPROVAL_FORBIDDEN',
      'You cannot approve an approval request you raised yourself'
    );
  }

  // A request naming a rule this company cannot see (another tenant's, or one of
  // migration 234's company_id-NULL seeds) must not fall back to the admin
  // default — that would silently lower an owner-only requirement.
  if (row.rule_id != null && row.resolved_rule_id == null) {
    throw new ApprovalDecisionError(
      'APPROVER_ROLE_REQUIRED',
      'This approval names a rule that does not belong to this company and cannot be decided'
    );
  }

  // No company_users row means no role to rank. Refuse outright rather than
  // ranking '' as 0: a rule demanding 'viewer' is also rank 0, and 0 < 0 is
  // false, so the comparison below would let a non-member decide it.
  if (row.decider_role == null) {
    throw new ApprovalDecisionError(
      'APPROVER_ROLE_REQUIRED',
      'You have no role in this company and cannot decide approvals'
    );
  }

  // The demand RATCHETS: the higher of the role the request was raised under
  // (`required_role`, migration 669) and the bound rule's role today.
  //
  // Reading the live rule alone made this guard worth only what the write path
  // to the rule is worth, and rule authority deliberately lets an actor edit any
  // rule at or below their own rank. An admin facing an admin-only request of
  // their OWN therefore had two ways to hand it to a manager: lower the bound
  // rule's approver_role, or push the rule out of the candidate set and re-POST
  // so the request rebound to a laxer one. Taking the maximum closes both, and
  // still lets a policy change apply to everything raised after it.
  //
  // A row from before 669 carries no snapshot and is governed by the live rule
  // exactly as it always was.
  const ruleRole = row.approver_role != null ? String(row.approver_role) : 'admin';
  const snapshotRole = row.required_role != null ? String(row.required_role) : null;
  const demandedRole = snapshotRole != null && requiredRank(snapshotRole) > requiredRank(ruleRole)
    ? snapshotRole
    : ruleRole;
  const userRole = String(row.decider_role);
  if (actorRank(userRole) < requiredRank(demandedRole)) {
    throw new ApprovalDecisionError(
      'APPROVER_ROLE_REQUIRED',
      `This approval requires the ${demandedRole} role`
    );
  }
}
