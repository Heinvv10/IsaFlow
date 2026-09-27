/**
 * Who AUTHORED the content an approval vouches for, and so may not approve it
 * (R-035 PR2; Hein, 2026-09-27: refuse the real authors).
 *
 * Refused: the current requester (assertMayDecide's own K-043 check, with the
 * sole-approver exception) and EVERY author of the content —
 * `approval_document_authors` (migration 712): the creator plus every user
 * whose edit moved the approval digest, accumulated and never removed (review
 * MEDIUM-1: "last editor" let a colleague's small edit, or an account merge,
 * strip the creator's authorship). Both the authors as they stand NOW and as
 * snapshotted on the request when it was raised or re-stamped
 * (`approval_requests.content_authors`) are refused. A system or agent creator
 * (a uuid no member holds) refuses nobody.
 *
 * A PAST requester who authored nothing current MAY approve — this replaces
 * PR1's blanket past-requester refusal, which left small companies with nobody
 * eligible. A type with no editor tracking yet (the function answers NULL)
 * keeps that refusal until its own PR tracks editors.
 *
 * The refusal says who may still approve: the role and how many members
 * qualify, never their names.
 */

import { sql } from '@/lib/neon';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';

export interface ContentAuthorFacts {
  requester: string;
  /** approval_document_authors() now; null for a type with no editor tracking. */
  liveAuthors: string[] | null;
  /** approval_requests.content_authors, taken at raise / re-stamp. */
  snapshotAuthors: string[];
  /** The decider is in approval_requests.past_requesters. */
  wasRequester: boolean;
}

type MemberRow = { user_id: string; role: string; is_active: boolean | null; status: string | null; suspended_at: string | null };

/**
 * Other members in good standing who could approve: rank enough (`qualifies`,
 * the caller's ladder), neither the requester nor an author. Read through
 * approval_company_other_members (SECURITY DEFINER; app_user cannot see the
 * roster), which answers only for the request's own user and company.
 */
async function eligibleOthers(companyId: string, decidedBy: string, excluded: Set<string>,
  qualifies: (role: string) => boolean): Promise<number> {
  const members = (await sql`
    SELECT m.user_id, m.role, m.is_active, m.status, m.suspended_at
    FROM approval_company_other_members(${companyId}::UUID, ${decidedBy}::TEXT) m
  `) as MemberRow[];
  return members.filter((m) => isActiveUserAccount(m) && !excluded.has(String(m.user_id)) && qualifies(String(m.role))).length;
}

/** The refusal message when `decidedBy` may not approve as an author, else null. */
export async function contentAuthorRefusal(companyId: string, decidedBy: string, facts: ContentAuthorFacts,
  demandedRole: string, qualifies: (role: string) => boolean): Promise<string | null> {
  if (facts.liveAuthors === null) {
    return facts.wasRequester
      ? 'You cannot approve an approval request you raised for an earlier version of this document'
      : null;
  }
  const authors = new Set([...facts.liveAuthors, ...facts.snapshotAuthors]);
  if (!authors.has(decidedBy)) return null;

  const n = await eligibleOthers(companyId, decidedBy, new Set([facts.requester, ...authors]), qualifies);
  const who = n > 0
    ? `${n} other member${n === 1 ? '' : 's'} with the ${demandedRole} role or above ${n === 1 ? 'qualifies' : 'qualify'}`
    : `no other member with the ${demandedRole} role or above qualifies — reject this request and have its author `
      + 'submit it again; the previous requester may then approve it';
  return 'You cannot approve this request: you authored the content it covers (you created the document or made '
    + `an edit that changed it). It needs a member who neither raised the request nor authored the content — ${who}.`;
}
