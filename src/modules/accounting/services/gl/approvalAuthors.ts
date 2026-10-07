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
  /** The decider's company role, and whether enforcement is on — the sole-approver route needs both. */
  deciderRole: string | null;
  enforced: boolean;
  /** The request's document type: the refusal names the document (R-035 PR4 round 2). */
  documentType?: string;
}

/**
 * The words that differ by document. A customer invoice may carry authors of
 * the content it was converted or minted from (a quote, an order, a template),
 * so its dead end — every member of the rank authored or raised it, e.g. two
 * owners where one priced the quote and the other converted it — has its own
 * way out (Hein, 2026-10-06, an accepted limit): the source's author performs
 * the conversion, run or invoicing themselves. Never "leave it to another
 * member": whoever converts, runs or invoices is an author of the invoice too,
 * so handing the step on re-makes the dead end (round 4). Every other type
 * keeps PR2's text byte for byte.
 */
function wording(documentType: string | undefined) {
  if (documentType === 'customer_invoice') {
    return {
      created: 'you created the invoice, made an edit that changed it, or wrote or re-priced the quote, sales order, '
        + 'time entry or recurring template it came from',
      deadEnd: 'Have the author of the source — the quote, sales order or recurring template, or whoever set the rate '
        + 'or hours of a time entry it bills — perform the conversion, run or invoicing themselves, so another '
        + 'eligible approver can approve the invoice, or have someone',
    };
  }
  // A payment or batch carries the authors of the bills it pays, whoever
  // re-pointed it or changed its payee's bank details, and whoever set the
  // payee's current bank details (R-035 PR5, decision (b)). Its way out
  // names the payment, never a bill: the bills' author creates it themselves,
  // so whoever did not capture them may approve it.
  if (documentType === 'supplier_payment' || documentType === 'payment_batch') {
    const doc = documentType === 'supplier_payment' ? 'payment' : 'batch';
    return {
      created: `you created the ${doc}, merged a supplier it pays, set a payee's current bank details or changed them `
        + 'while it was unpaid, or captured or edited a bill it pays',
      deadEnd: `Cancel the ${doc} and have the author of the bills it pays create it themselves, so another eligible `
        + "approver — one who did not set the payee's bank details — can approve it, or have someone",
    };
  }
  // A manual journal carries its recurring template's authors and whoever
  // merged an account its lines name (R-035 PR6). It has no edit route, so its
  // way out is the template's author running it themselves.
  if (documentType === 'manual_journal') {
    return {
      created: 'you created the journal, merged an account its lines name, or created or edited the recurring '
        + 'template it was generated from',
      deadEnd: 'Have the author of the recurring template it came from generate it themselves, so another eligible '
        + 'approver can approve the journal, or have someone',
    };
  }
  return { created: 'you created the document or made an edit that changed it', deadEnd: 'Cancel and re-enter the bill, or have someone' };
}

type MemberRow = { user_id: string; role: string; is_active: boolean | null; status: string | null; suspended_at: string | null };

/**
 * Who, besides the decider, could approve: other members in good standing
 * with rank enough (`qualifies`, the caller's ladder) who are neither the
 * requester nor an author (`eligible`), and whether the REQUESTER is such a
 * member apart from having raised it (`requesterCould` — the path that opens
 * if an author re-submits). Read through approval_company_other_members
 * (SECURITY DEFINER; app_user cannot see the roster), which answers only for
 * the request's own user and company.
 */
async function approversLeft(companyId: string, decidedBy: string, requester: string, authors: Set<string>,
  qualifies: (role: string) => boolean): Promise<{ eligible: number; requesterCould: boolean; anyOtherOfRank: boolean }> {
  const members = (await sql`
    SELECT m.user_id, m.role, m.is_active, m.status, m.suspended_at
    FROM approval_company_other_members(${companyId}::UUID, ${decidedBy}::TEXT) m
  `) as MemberRow[];
  const able = members.filter((m) => isActiveUserAccount(m) && qualifies(String(m.role)) && !authors.has(String(m.user_id)));
  return {
    eligible: able.filter((m) => String(m.user_id) !== requester).length,
    requesterCould: able.some((m) => String(m.user_id) === requester),
    // assertMayDecide's sole-approver test: any OTHER active member of the rank, author or not.
    anyOtherOfRank: members.some((m) => isActiveUserAccount(m) && qualifies(String(m.role))),
  };
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

  const { eligible: n, requesterCould, anyOtherOfRank } =
    await approversLeft(companyId, decidedBy, facts.requester, authors, qualifies);
  const words = wording(facts.documentType);
  const refusal = `You cannot approve this request: you authored the content it covers (${words.created}).`;
  if (n > 0) {
    return `${refusal} It needs a member who neither raised the request nor authored the content — ${n} other `
      + `member${n === 1 ? '' : 's'} with the ${demandedRole} role or above ${n === 1 ? 'qualifies' : 'qualify'}.`;
  }
  if (requesterCould) {
    return `${refusal} No other member with the ${demandedRole} role or above qualifies — reject this request and `
      + 'have one of its authors submit it again; the previous requester may then approve it.';
  }
  // The decider alone holds the rank: as their OWN request, the sole-approver
  // exception (assertMayDecide, Q2) lets them approve it even as its author.
  if (facts.enforced && facts.deciderRole !== null && qualifies(facts.deciderRole) && !anyOtherOfRank) {
    return `${refusal} You are the only eligible approver (the only member with the ${demandedRole} role or above): `
      + 'reject this request and submit it for approval yourself — as the sole approver you may then approve your own request.';
  }
  return `${refusal} No eligible approver remains: every member with the ${demandedRole} role or above either `
    + `authored the content or raised the request. ${words.deadEnd} with the `
    + `${demandedRole} role or above who did not author it approve it.`;
}
