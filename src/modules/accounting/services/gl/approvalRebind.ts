/**
 * Re-binding a PENDING approval request when it is requested again — split out
 * of approvalDocuments.ts to hold that file under the 300-line ceiling.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ApprovalRequest, ApprovalRule } from './approvalService';
import type { ApprovalDocument } from './approvalDocuments';
import { mapRequest } from './approvalMatching';
import { requiredRank } from './approvalAuthority';

type Row = Record<string, unknown>;

/**
 * Bring a pending request onto the rule the CURRENT facts choose — but only
 * ever UPWARDS.
 *
 * Returning the existing row unconditionally let the FIRST request for a
 * document pin its authority permanently: one raised under a laxer rule stayed
 * governed by that rule even when the document's own amount, re-resolved, chose
 * a stricter one. Re-binding in BOTH directions was the inverse of that defect,
 * and the worse half: the requester does not have to touch the document to
 * change which rule today's facts choose, because rule authority deliberately
 * lets them edit any rule at or below their own rank. An admin facing an
 * admin-only request of their own raised that rule's `condition_value` out of
 * range (or deactivated it), re-POSTed, and the pending row moved to the
 * `manager any` rule beside it — a manager then cleared their R500 000 bill.
 *
 * So: new facts may make a pending request STRICTER; nothing may make it laxer.
 * The comparison is against `requiredRole`, the snapshot taken when the request
 * was raised, not against the bound rule's live role — the live role is itself
 * editable downwards by the same actor (approvalAuthority takes the higher of
 * the two for the same reason).
 *
 * CONTENT follows the document in every branch (R-035): when the digest
 * changed, the request now vouches for new content, so it is re-stamped as
 * raised by `requestedBy`, now — requested_by, requested_at and the roster
 * snapshot. Keeping the original requester let an editor approve their own
 * edit: A requests, B edits and re-requests, B approves as "not self". The
 * requester it replaces joins `past_requesters`, none of whom may approve —
 * else the author sheds the role instead: A requests, A edits, C re-requests,
 * A approves.
 */
export async function rebindPendingRequest(
  companyId: string,
  existing: ApprovalRequest,
  matched: ApprovalRule | null,
  document: ApprovalDocument,
  requestedBy: string,
): Promise<ApprovalRequest> {
  // checkApproval fills `requiredRole` from the bound rule for rows raised
  // before migration 669, so this is never a free pass. It stays NULL only where
  // no rule of this company is bound at all — and the decide path demands the
  // 'admin' column default for exactly those, so the floor is the same one.
  const currentRole = existing.requiredRole ?? 'admin';
  const digestChanged = existing.documentDigest !== document.digest;
  // No active rule governs the document now, or today's rule is laxer: the
  // pending request keeps the authority it was raised under rather than being
  // silently freed. Only its content binding (and so its requester) moves.
  const keepBinding = !matched || requiredRank(matched.approverRole) < requiredRank(currentRole);
  if (keepBinding && !digestChanged) return existing;
  if (!keepBinding && existing.ruleId === matched!.id && Number(existing.amount ?? 0) === document.amount
      && existing.requiredRole === matched!.approverRole && !digestChanged) {
    return existing;
  }
  const ruleId = keepBinding ? null : matched!.id;
  const role = keepBinding ? null : matched!.approverRole;

  // A NULL-digest request (raised between migration 708 and this code, or never
  // bound) heals here: NULL !== the document's digest, so it is re-stamped.
  const rows = (await sql`
    UPDATE approval_requests ar SET
      rule_id = COALESCE(${ruleId}::UUID, ar.rule_id),
      required_role = COALESCE(${role}::TEXT, ar.required_role),
      amount = ${document.amount}::NUMERIC,
      document_reference = ${document.reference}::TEXT,
      document_digest = ${document.digest}::TEXT,
      past_requesters = CASE WHEN ${digestChanged}::BOOLEAN AND ar.requested_by <> ${requestedBy}::UUID
                             THEN array_append(ar.past_requesters, ar.requested_by) ELSE ar.past_requesters END,
      requested_by = CASE WHEN ${digestChanged}::BOOLEAN THEN ${requestedBy}::UUID ELSE ar.requested_by END,
      requested_at = CASE WHEN ${digestChanged}::BOOLEAN THEN NOW() ELSE ar.requested_at END,
      approver_roster = CASE WHEN ${digestChanged}::BOOLEAN THEN (
        SELECT approval_roster_snapshot(${companyId}::UUID, ${requestedBy}::TEXT)
        WHERE EXISTS (SELECT 1 FROM approval_enforcement ae
                      WHERE ae.company_id = ${companyId}::UUID AND ae.document_type = ar.document_type)
      ) ELSE ar.approver_roster END
    WHERE ar.id = ${existing.id}::UUID AND ar.company_id = ${companyId} AND ar.status = 'pending'
    RETURNING *
  `) as Row[];
  // Decided between the read and the write: nothing pending to re-bind.
  if (!rows[0]) return existing;
  log.info('Approval request re-bound', {
    id: existing.id, fromRuleId: existing.ruleId, toRuleId: ruleId ?? existing.ruleId,
    contentChanged: digestChanged, requestedBy: digestChanged ? requestedBy : existing.requestedBy,
  }, 'accounting');
  return mapRequest(rows[0]);
}
