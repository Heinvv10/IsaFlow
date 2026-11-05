/**
 * Keep a pending pay-run approval decidable (R-035, sole-approver fallback).
 *
 * A pay run's requester may approve their own request only when nobody else could (decision Q2). A member write
 * that takes the last OTHER eligible approver away while a pay_run request is pending leaves the requester as the
 * only one left, so the fallback would then let them clear their own payroll. Such a demotion or removal is
 * refused (409) until the request is decided or withdrawn.
 *
 * Eligible = in good standing (an active, unsuspended account) and ranked at or above what the request demands
 * (the ratchet: the higher of the role it was raised under and the bound rule's role today, as assertMayDecide
 * judges), and not the request's own requester. Ranks come from gl/approvalRank, the ladder assertMayDecide uses.
 *
 * ONE function, `refuseLastPayRunApprover`, judges every path that can reduce a company's eligible approvers; the
 * two wrappers below are for callers that have no migration_admin client of their own. Callers: memberWrites
 * (company role change, removal), companyMembershipService (platform-admin role change, removal),
 * adminUserActionsService (suspension, user delete, onboarding reset). Not guarded: accepting an invitation that
 * re-roles an existing member, which needs that member's own credentials.
 *
 * Limit, by design (the sole-approver fallback is kept and logged): this guards the window while a request is
 * pending. A demotion made BEFORE a request is raised is in the request's roster snapshot, and a requester can
 * withdraw their own request and then demote; neither is stopped here. They are made visible instead (the audit
 * trail and the run's `selfApprovedSoleApprover` flag and note).
 */
import type { PoolClient } from 'pg';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { actorRank, requiredRank } from '../gl/approvalRank';

/** The member write would leave a pending pay-run approval with no approver but its requester. Routes answer 409. */
export class PayRunApproverProtectedError extends Error {
  constructor() {
    super(
      'This member is the only other person who can approve a pay run that is awaiting approval. '
      + 'Approve or reject that request first, or make someone else an approver, then change this member.',
    );
    this.name = 'PayRunApproverProtectedError';
  }
}

/**
 * Throws PayRunApproverProtectedError when changing `userId` to `newRole` (null: removing them) would leave a
 * pending pay_run request in `companyId` without an eligible approver other than its requester.
 */
export async function refuseLastPayRunApprover(
  client: PoolClient,
  companyId: string,
  userId: string,
  newRole: string | null,
): Promise<void> {
  const pending = (await client.query<{ requested_by: string; required_role: string | null; rule_role: string | null }>(
    `SELECT ar.requested_by::TEXT AS requested_by, ar.required_role, rl.approver_role AS rule_role
       FROM approval_requests ar
       LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
      WHERE ar.company_id = $1::UUID AND ar.document_type = 'pay_run' AND ar.status = 'pending'`,
    [companyId],
  )).rows;
  if (pending.length === 0) return;
  // The rank helpers the approval definers use are not executable by this pool; the TypeScript ladder is the same one.
  const members = (await client.query<{ user_id: string; role: string; in_good_standing: boolean }>(
    `SELECT cu.user_id::TEXT AS user_id, cu.role,
            (u.is_active IS TRUE AND u.suspended_at IS NULL AND (u.status IS NULL OR lower(u.status) = 'active')) AS in_good_standing
       FROM company_users cu LEFT JOIN users u ON u.id::TEXT = cu.user_id::TEXT
      WHERE cu.company_id = $1::UUID`,
    [companyId],
  )).rows;
  const target = members.find((m) => m.user_id.toLowerCase() === userId.toLowerCase());
  if (!target) return;
  const after = newRole === null ? -1 : actorRank(newRole);
  for (const request of pending) {
    // assertMayDecide's ratchet: the higher of the role the request was raised under and the bound rule's role today.
    const demand = Math.max(requiredRank(request.rule_role ?? 'admin'), request.required_role == null ? 0 : requiredRank(request.required_role));
    const requester = request.requested_by.toLowerCase();
    const eligible = (m: { user_id: string; role: string; in_good_standing: boolean }): boolean =>
      m.in_good_standing && m.user_id.toLowerCase() !== requester && actorRank(m.role) >= demand;
    if (!eligible(target) || after >= demand) continue;
    if (!members.some((m) => m !== target && eligible(m))) throw new PayRunApproverProtectedError();
  }
}

/** `refuseLastPayRunApprover` on a migration_admin connection of its own, for callers that write on another pool. */
export async function assertPayRunApproverRetained(companyId: string, userId: string, newRole: string | null): Promise<void> {
  await migrationAdminTx('check pay-run approver', (client) => refuseLastPayRunApprover(client, companyId, userId, newRole));
}

/**
 * The same judgement for a change that takes `userId` out of EVERY company they belong to (suspension, deleting the
 * user, an onboarding reset): each company with a pending pay_run request is judged as if they were removed.
 */
export async function assertPayRunApproverRetainedEverywhere(userId: string): Promise<void> {
  await migrationAdminTx('check pay-run approver of a user', async (client) => {
    const companies = (await client.query<{ company_id: string }>(
      `SELECT DISTINCT cu.company_id::TEXT AS company_id
         FROM company_users cu
         JOIN approval_requests ar ON ar.company_id = cu.company_id AND ar.document_type = 'pay_run' AND ar.status = 'pending'
        WHERE lower(cu.user_id::TEXT) = lower($1)`,
      [userId],
    )).rows;
    for (const c of companies) await refuseLastPayRunApprover(client, c.company_id, userId, null);
  });
}
