/**
 * Keep a pending pay-run approval decidable (R-035, sole-approver fallback).
 *
 * A pay run's requester may approve their own request only when nobody else could (decision Q2). A member write
 * that takes the last OTHER eligible approver away while a pay_run request is pending leaves the requester as the
 * only one left. Such a demotion or removal by a company or platform admin is refused (409) until the request is
 * decided or withdrawn.
 *
 * Eligible = exactly who approval_request_decide (migration 872) would let approve it: in good standing (an active,
 * unsuspended account), ranked at or above what the request demands (the ratchet: the higher of the role it was raised
 * under and the bound rule's role today), not the request's requester, and not an author of the content (the run's
 * `prepared_by` and the request's `content_authors` snapshot; RA001). A pay run always has a header, so the
 * "earlier requester" branch of RA001, which applies only to a type with no author tracking, never applies.
 * Ranks come from gl/approvalRank, the ladder assertMayDecide uses.
 *
 * ONE judgement (`strandedPayRunRequests`) serves every path. Callers: memberWrites (company role change, removal),
 * companyMembershipService (platform-admin role change, removal) and adminUserActionsService (onboarding reset).
 * Suspension and user deletion are NEVER refused (emergency revocation must always land): they only report what
 * they strand (`findStrandedPayRunRequests`, logged and put on the admin audit row). The stranded request itself
 * cannot be self-approved as it stands: the sole-approver fallback also requires the roster to be unchanged since the
 * request was raised (approval_roster_snapshot holds every other member's role, standing and suspension), so it is
 * refused with "the company members or roles changed". It does NOT stay that way for ever: withdrawing and raising
 * again, or a content change plus recalculation and a re-request (migration 872 re-stamps the SAME request with a
 * fresh roster, v_changed), takes a new roster snapshot and the fallback then applies. That is by design under the
 * ruling to keep the fallback; the audit flag and the run note are what make it visible. Accepting an invitation that
 * re-roles an existing member is not guarded: it needs that member's own credentials (the snapshot still blocks
 * self-approval of anything pending).
 *
 * LOCK: the check and the write must not interleave with another member write of the same company (two admins
 * demoting the two other approvers at once would each see the other still eligible). So the check takes the
 * transaction-scoped advisory lock `pay_run_approvers:<company id>` first, on the SAME transaction as the write,
 * held to its COMMIT. It is a leaf in payrollRunLock.ts's order: nothing in the pay-run, approval or posting code
 * takes it, and it is always taken AFTER the member rows and the owner lock (memberWrites: rows, owner lock, this;
 * the platform service calls it after assertAnotherOwner; the onboarding reset locks the user's rows and owner
 * locks first, in company-id order, for the same reason). A change spanning companies takes them in company-id order.
 * The check itself may run on another connection (a platform-admin write is on the platform pool): it reads committed
 * data, and a peer that held the lock has committed before it is granted. That connection is a migration_admin one
 * (pool max 4) while the request holds the lock on its own transaction. If the pool is full of waiters for this very
 * lock, the wait ends with the 5 s lock_timeout and a retryable refusal; if it is exhausted by anything else, the
 * checkout fails after connectionTimeoutMillis (15 s) with an unclassified error (a 500 on the platform routes, a
 * generic 400 on the reset). Either way nothing was written. Judging on the platform transaction itself was not
 * done: platform_admin's access to these tables is not what the member writes already rely on, and a request it could
 * not see would read as "no pending request", failing open; migration_admin (BYPASSRLS) is the known reader.
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
  const pending = (await client.query<{
    id: string; requested_by: string; required_role: string | null; rule_role: string | null; authors: string[];
  }>(
    // authors: approval_document_authors for a pay run (the run's last preparer) and the snapshot taken when the request
    // was raised or re-stamped (approval_request_decide: RA001, 'you authored the content it covers').
    `SELECT ar.id::TEXT AS id, ar.requested_by::TEXT AS requested_by, ar.required_role, rl.approver_role AS rule_role,
            array_remove(ARRAY[h.prepared_by::TEXT] || COALESCE(ar.content_authors::TEXT[], '{}'::TEXT[]), NULL) AS authors
       FROM approval_requests ar
       LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
       LEFT JOIN payroll_run_headers h ON h.id = ar.document_id AND h.company_id = ar.company_id
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
  // By PERSON: user_id is compared case-insensitively and the writes match lower(user_id), so a case-variant row of the
  // same person is the target too (never "another approver"), and the target could approve if any of their rows could.
  const person = userId.toLowerCase();
  const targetRows = members.filter((m) => m.user_id.toLowerCase() === person);
  if (targetRows.length === 0) return [];
  const after = newRole === null ? -1 : actorRank(newRole);
  const stranded: string[] = [];
  for (const request of pending) {
    // assertMayDecide's ratchet: the higher of the role the request was raised under and the bound rule's role today.
    const demand = Math.max(requiredRank(request.rule_role ?? 'admin'), request.required_role == null ? 0 : requiredRank(request.required_role));
    const requester = request.requested_by.toLowerCase();
    const authors = new Set(request.authors.map((a) => a.toLowerCase()));
    const eligible = (m: Member): boolean => {
      const id = m.user_id.toLowerCase();
      return m.in_good_standing && id !== requester && !authors.has(id) && actorRank(m.role) >= demand;
    };
    if (!targetRows.some(eligible) || after >= demand) continue;
    if (!members.some((m) => m.user_id.toLowerCase() !== person && eligible(m))) stranded.push(request.id);
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

/** Companies where `userId` is a member and a pay_run request is pending, in company-id order. Read only. */
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
 * The same, for a change that takes `userId` out of EVERY company they belong to (onboarding reset). In the order
 * every member writer takes its locks (rows, owner lock, approver lock; see the header), companies in id order:
 * the user's membership rows, then the owner lock of each company they own, then the approver lock of EACH company
 * they belong to, and only then the companies are judged, each as a removal. Locking before listing means a request
 * raised before the judge reads is judged (one raised after that is not, but its requester still cannot self-approve it
 * on the old roster: the roster snapshot), and taking rows first keeps a concurrent role change of the same user from meeting
 * this one in the opposite order (it waits on the rows, before it holds the approver lock).
 */
export async function assertPayRunApproverRetainedEverywhere(userId: string): Promise<void> {
  const memberships = await sql<{ company_id: string; is_owner: boolean }>`
    SELECT company_id::TEXT AS company_id, public.company_member_role_is_owner(role) AS is_owner
      FROM company_users
     WHERE lower(user_id::TEXT) = lower(${userId})
     ORDER BY company_id, id
       FOR UPDATE
  `;
  const companies = [...new Set(memberships.map((m) => m.company_id))];
  const owned = new Set(memberships.filter((m) => m.is_owner).map((m) => m.company_id));
  for (const companyId of companies) {
    if (owned.has(companyId)) await sql`SELECT pg_advisory_xact_lock(hashtextextended('company_owners:' || ${companyId}::uuid::text, 0))`;
  }
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
