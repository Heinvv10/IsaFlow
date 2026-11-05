/**
 * Keep a pending pay-run approval decidable (R-035, sole-approver fallback).
 *
 * A pay run's requester may approve their own request only when nobody else could (decision Q2). A member write
 * that takes the last OTHER eligible approver away while a pay_run request is pending leaves the requester as the
 * only one left. Such a demotion or removal by a company or platform admin is refused (409) until the request is
 * decided or withdrawn.
 *
 * Eligible = in good standing (an active, unsuspended account) and ranked at or above what the request demands
 * (the ratchet: the higher of the role it was raised under and the bound rule's role today, as assertMayDecide
 * judges), and not the request's own requester. Ranks come from gl/approvalRank, the ladder assertMayDecide uses.
 *
 * ONE judgement (`strandedPayRunRequests`) serves every path. Callers: memberWrites (company role change, removal),
 * companyMembershipService (platform-admin role change, removal) and adminUserActionsService (onboarding reset).
 * Suspension and user deletion are NEVER refused (emergency revocation must always land): they only report what
 * they strand (`findStrandedPayRunRequests`, logged and put on the admin audit row). A pending request whose last
 * other approver is suspended or deleted cannot be self-approved either: the sole-approver fallback also requires
 * the roster to be unchanged since the request was raised (approval_roster_snapshot holds every other member's role,
 * standing and suspension), so it is refused with "the company members or roles changed" until the requester raises
 * a new request on the new roster. Accepting an invitation that re-roles an existing member is not guarded: it needs
 * that member's own credentials.
 *
 * LOCK: the check and the write must not interleave with another member write of the same company (two admins
 * demoting the two other approvers at once would each see the other still eligible). So the check takes the
 * transaction-scoped advisory lock `pay_run_approvers:<company id>` first, on the SAME transaction as the write,
 * held to its COMMIT. It is a leaf in payrollRunLock.ts's order: nothing in the pay-run, approval or posting code
 * takes it, and it is always taken AFTER the member rows and the owner lock (memberWrites: rows, owner lock, this;
 * the platform service calls it after assertAnotherOwner). A change spanning companies takes them in company-id order.
 * The check itself may run on another connection (a platform-admin write is on the platform pool): it reads committed
 * data, and a peer that held the lock has committed before it is granted.
 *
 * Limit, by design (the sole-approver fallback is kept and logged): this guards the window while a request is
 * pending. A demotion made BEFORE a request is raised is in the request's roster snapshot, and a requester can
 * withdraw their own request and then demote; neither is stopped here. They are made visible instead (the audit
 * trail and the run's `selfApprovedSoleApprover` flag and note).
 */
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
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

export interface StrandedPayRunRequest { companyId: string; requestId: string }

const lockKey = (companyId: string): string => `pay_run_approvers:${companyId}`;

type Member = { user_id: string; role: string; in_good_standing: boolean };

/**
 * The ids of `companyId`'s pending pay_run requests that would be left with no eligible approver other than their
 * requester if `userId` became `newRole` (null: left the company). Reads only; no lock.
 */
async function strandedRequestIds(client: PoolClient, companyId: string, userId: string, newRole: string | null): Promise<string[]> {
  const pending = (await client.query<{ id: string; requested_by: string; required_role: string | null; rule_role: string | null }>(
    `SELECT ar.id::TEXT AS id, ar.requested_by::TEXT AS requested_by, ar.required_role, rl.approver_role AS rule_role
       FROM approval_requests ar
       LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
      WHERE ar.company_id = $1::UUID AND ar.document_type = 'pay_run' AND ar.status = 'pending'`,
    [companyId],
  )).rows;
  if (pending.length === 0) return [];
  // The rank helpers the approval definers use are not executable by this pool; the TypeScript ladder is the same one.
  const members = (await client.query<Member>(
    `SELECT cu.user_id::TEXT AS user_id, cu.role,
            (u.is_active IS TRUE AND u.suspended_at IS NULL AND (u.status IS NULL OR lower(u.status) = 'active')) AS in_good_standing
       FROM company_users cu LEFT JOIN users u ON u.id::TEXT = cu.user_id::TEXT
      WHERE cu.company_id = $1::UUID`,
    [companyId],
  )).rows;
  const target = members.find((m) => m.user_id.toLowerCase() === userId.toLowerCase());
  if (!target) return [];
  const after = newRole === null ? -1 : actorRank(newRole);
  const stranded: string[] = [];
  for (const request of pending) {
    // assertMayDecide's ratchet: the higher of the role the request was raised under and the bound rule's role today.
    const demand = Math.max(requiredRank(request.rule_role ?? 'admin'), request.required_role == null ? 0 : requiredRank(request.required_role));
    const requester = request.requested_by.toLowerCase();
    const eligible = (m: Member): boolean => m.in_good_standing && m.user_id.toLowerCase() !== requester && actorRank(m.role) >= demand;
    if (!eligible(target) || after >= demand) continue;
    if (!members.some((m) => m !== target && eligible(m))) stranded.push(request.id);
  }
  return stranded;
}

async function judge(client: PoolClient, companyId: string, userId: string, newRole: string | null): Promise<void> {
  if ((await strandedRequestIds(client, companyId, userId, newRole)).length > 0) throw new PayRunApproverProtectedError();
}

/**
 * For a caller already in a migration_admin transaction that makes the write (memberWrites): takes the company's
 * approver lock on that transaction, then throws PayRunApproverProtectedError when changing `userId` to `newRole`
 * (null: removing them) would leave a pending pay_run request without an eligible approver other than its requester.
 */
export async function refuseLastPayRunApprover(
  client: PoolClient,
  companyId: string,
  userId: string,
  newRole: string | null,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(companyId)]);
  await judge(client, companyId, userId, newRole);
}

/** Judges on a migration_admin connection of its own, for a caller whose write is on the platform pool. */
async function judgeOnMigrationAdmin(checks: Array<[string, string | null]>, userId: string): Promise<void> {
  await migrationAdminTx('check pay-run approver', async (client) => {
    for (const [companyId, role] of checks) await judge(client, companyId, userId, role);
  });
}

/**
 * For a write on the platform_admin pool (platform-admin role change, link removal): takes the approver lock on the
 * request's own transaction, the one that makes the write, then judges.
 */
export async function assertPayRunApproverRetained(companyId: string, userId: string, newRole: string | null): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(companyId)}, 0))`;
  await judgeOnMigrationAdmin([[companyId, newRole]], userId);
}

/** Companies where `userId` is a member and a pay_run request is pending, in company-id order. */
async function companiesWithPendingRequests(userId: string): Promise<string[]> {
  return migrationAdminTx('list pay-run approver companies', async (client) => (await client.query<{ company_id: string }>(
    `SELECT DISTINCT cu.company_id::TEXT AS company_id
       FROM company_users cu
       JOIN approval_requests ar ON ar.company_id = cu.company_id AND ar.document_type = 'pay_run' AND ar.status = 'pending'
      WHERE lower(cu.user_id::TEXT) = lower($1)
      ORDER BY 1`,
    [userId],
  )).rows.map((r) => r.company_id));
}

/**
 * The same, for a change that takes `userId` out of EVERY company they belong to (onboarding reset): the approver
 * locks of the companies with a pending request, in company-id order, then each judged as a removal.
 */
export async function assertPayRunApproverRetainedEverywhere(userId: string): Promise<void> {
  const companies = await companiesWithPendingRequests(userId);
  for (const companyId of companies) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(companyId)}, 0))`;
  await judgeOnMigrationAdmin(companies.map((c): [string, string | null] => [c, null]), userId);
}

/**
 * Read only: the pending pay_run requests that taking `userId` out of every company (suspension, deletion) leaves
 * without an eligible approver other than their requester. Never throws for them; the caller reports.
 */
export async function findStrandedPayRunRequests(userId: string): Promise<StrandedPayRunRequest[]> {
  const companies = await companiesWithPendingRequests(userId);
  if (companies.length === 0) return [];
  return migrationAdminTx('find stranded pay-run requests', async (client) => {
    const found: StrandedPayRunRequest[] = [];
    for (const companyId of companies) {
      for (const requestId of await strandedRequestIds(client, companyId, userId, null)) found.push({ companyId, requestId });
    }
    return found;
  });
}
