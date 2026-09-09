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

/** The request is gone, belongs elsewhere, or someone else already decided it. */
export class ApprovalRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`Approval request ${requestId} not found or already decided`);
    this.name = 'ApprovalRequestNotFoundError';
  }
}

// Rank ladder for approver authority. ROLE_HIERARCHY in @/lib/auth/types has no
// entry for 'accountant' or 'user', and its `?? 0` fallback would let anybody
// satisfy a rule whose approver_role is 'accountant' — one of the defaults
// seeded by migration 234. tests/unit/services/gl/approverRankLadder.test.ts
// locks this ladder's ordering against ROLE_HIERARCHY so the two cannot drift.
export const APPROVER_RANK: Record<string, number> = {
  super_admin: 7,
  owner: 6,
  system: 5,
  admin: 4,
  manager: 3,
  accountant: 2,
  storeman: 1,
  technician: 1,
  user: 1,
  viewer: 0,
};

/** Roles a rule may demand. Anything else is a typo that would silently mean admin. */
export const APPROVER_ROLES = Object.keys(APPROVER_RANK);
export const isApproverRole = (value: unknown): value is string =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(APPROVER_RANK, value);

/** An unrecognised rule role falls back to 'admin', the column default in 234. */
const requiredRank = (role: string): number => APPROVER_RANK[role] ?? APPROVER_RANK.admin!;

/** An unrecognised decider role carries no authority. */
const deciderRank = (role: string): number => APPROVER_RANK[role] ?? 0;

/**
 * Throws ApprovalDecisionError when `decidedBy` may not decide `requestId`.
 * Silent when the request does not exist or is already decided — the caller's
 * status-predicated UPDATE reports that case.
 */
export async function assertMayDecide(
  companyId: string,
  requestId: string,
  decidedBy: string
): Promise<void> {
  const rows = (await sql`
    SELECT (ar.requested_by::TEXT = ${decidedBy}) AS is_self,
           ar.rule_id,
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
    throw new ApprovalDecisionError(
      'SELF_APPROVAL_FORBIDDEN',
      'You cannot decide on an approval request you raised yourself'
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

  const ruleRole = row.approver_role != null ? String(row.approver_role) : 'admin';
  const userRole = row.decider_role != null ? String(row.decider_role) : '';
  if (deciderRank(userRole) < requiredRank(ruleRole)) {
    throw new ApprovalDecisionError(
      'APPROVER_ROLE_REQUIRED',
      `This approval requires the ${ruleRole} role`
    );
  }
}
