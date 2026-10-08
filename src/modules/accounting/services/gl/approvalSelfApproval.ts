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

/** Returned by assertMayDecide when the decision is a sole-approver self-approval. */
export interface SoleApproverSelfApproval {
  selfApproval: 'sole_approver';
  /** The ratcheted role the request demanded, which nobody else holds. */
  requiredRole: string;
  /** approval_requests.approver_roster — the roster the decision was allowed on. */
  approverRoster: unknown;
}

export interface SoleApproverFacts {
  /** Company roles of every OTHER member in good standing, now. */
  otherRoles: string[];
  /** A roster snapshot was taken at request time and the live roster still equals it. */
  rosterUnchanged: boolean;
  roster: unknown;
}

/**
 * The facts a sole-approver self-approval stands on, read in one statement.
 *
 * The roster comes through `approval_company_other_members` (migration 708,
 * SECURITY DEFINER): under withAuth this runs as app_user, which sees only its
 * own `users` row, so a direct query would find nobody else and allow every
 * self-approval. The function answers only for the request asking (the JWT
 * subject and withAuth's company GUC), and RAISES when it cannot see the
 * caller's own membership, so an RLS-blinded read fails the decide instead of
 * clearing it. It therefore works only inside withAuth's transaction.
 *
 * `rosterUnchanged` compares the snapshot taken when the request was raised
 * with `approval_roster_snapshot` now. company_users keeps no history, so this
 * is the only way to see a demotion (or removal, or promotion) made AFTER the
 * request; one made BEFORE it is in the snapshot and cannot be told apart from
 * the company's real shape — the audit row records the snapshot for review.
 */
export async function soleApproverFacts(companyId: string, requestId: string, userId: string): Promise<SoleApproverFacts> {
  const rows = (await sql`
    SELECT ar.approver_roster AS roster,
           (ar.approver_roster IS NOT NULL
            AND ar.approver_roster = approval_roster_snapshot(${companyId}::UUID, ${userId}::TEXT)) AS roster_unchanged,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'role', m.role, 'is_active', m.is_active, 'status', m.status, 'suspended_at', m.suspended_at))
             FROM approval_company_other_members(${companyId}::UUID, ${userId}::TEXT) m
           ), '[]'::jsonb) AS others
    FROM approval_requests ar
    WHERE ar.id = ${requestId}::UUID AND ar.company_id = ${companyId}
  `) as { roster: unknown; roster_unchanged: boolean | null; others: MemberRow[] }[];
  const row = rows[0];
  return {
    otherRoles: (row?.others ?? []).filter((m) => isActiveUserAccount(m)).map((m) => String(m.role)),
    rosterUnchanged: row?.roster_unchanged === true,
    roster: row?.roster ?? null,
  };
}

type MemberRow = { role: string; is_active: boolean | null; status: string | null; suspended_at: string | null };

/*
 * The distinct marker — an `approve` audit row on the request whose metadata
 * says it was the requester's own, allowed because nobody else could — is
 * written by approval_request_decide (migration 872), in the same transaction
 * as the decision, so an unrecorded self-approval cannot stand.
 */
