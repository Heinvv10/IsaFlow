/**
 * The approval gate: the one check every posting path consults before a
 * document enters the ledger or a subledger population (R-035).
 *
 * PR1 SHIPS IT UNCALLED. No posting path calls it until a later PR wires a
 * document type AND adds that type to ENFORCEABLE_DOCUMENT_TYPES; enforcement
 * cannot be switched on before then (approvalEnforcement.ts).
 *
 * A document is CLEARED when any of these holds:
 *   - enforcement is off for (company, type);
 *   - no active rule of the company matches it;
 *   - an APPROVED request exists for it, in this company, whose digest is the
 *     document's CURRENT digest and whose demanded role ranks at least as high
 *     as the strictest rule matching today (the ratchet: a manager approval
 *     does not clear once an owner rule governs).
 * "Approved" is derived, never stored on the document (decision Q3): approved
 * requests are terminal, and only decideRequest — behind assertMayDecide —
 * writes one. A request with a NULL digest (decided before migration 708, or a
 * type with no digest definition yet) never clears.
 */

import { sql } from '@/lib/neon';
import type { DocumentType } from './approvalService';
import { checkApproval } from './approvalMatching';
import { requiredRank } from './approvalAuthority';
import { resolveApprovalDocument } from './approvalDocuments';
import { isEnforced } from './approvalEnforcement';

export type ApprovalGateReason = 'APPROVAL_REQUIRED' | 'APPROVAL_PENDING' | 'APPROVAL_STALE';

export interface ApprovalGateRefusal {
  reason: ApprovalGateReason;
  /** The role today's strictest matching rule demands. */
  requiredRole: string;
  ruleName: string;
  /** The pending request (PENDING), the approval that went stale (STALE), or null. */
  requestId: string | null;
  documentType: DocumentType;
  documentReference: string | null;
}

const LABELS: Record<DocumentType, string> = {
  supplier_invoice: 'Supplier invoice',
  customer_invoice: 'Customer invoice',
  credit_note: 'Credit note',
  payment: 'Payment',
  journal_entry: 'Journal entry',
};

function refusalMessage(r: ApprovalGateRefusal): string {
  const subject = `${LABELS[r.documentType]}${r.documentReference ? ` ${r.documentReference}` : ''}`;
  switch (r.reason) {
    case 'APPROVAL_PENDING':
      return `${subject} is awaiting approval by a ${r.requiredRole} before it can be posted (rule: ${r.ruleName}).`;
    case 'APPROVAL_STALE':
      return `${subject} changed after it was approved; submit it for approval again (rule: ${r.ruleName}).`;
    case 'APPROVAL_REQUIRED':
      return `${subject} needs ${r.requiredRole} approval before it can be posted (rule: ${r.ruleName}).`;
  }
}

/** A posting path met a document the gate refuses. Routes answer it 409. */
export class ApprovalRequiredError extends Error {
  readonly code = 'APPROVAL_REQUIRED';
  readonly reason: ApprovalGateReason;
  readonly requiredRole: string;
  readonly requestId: string | null;

  constructor(refusal: ApprovalGateRefusal) {
    super(refusalMessage(refusal));
    this.name = 'ApprovalRequiredError';
    this.reason = refusal.reason;
    this.requiredRole = refusal.requiredRole;
    this.requestId = refusal.requestId;
  }
}

type Row = Record<string, unknown>;

/** Read-only. Null when the document may be posted, else why not. */
export async function evaluateApprovalGate(
  companyId: string,
  documentType: DocumentType,
  documentId: string,
): Promise<ApprovalGateRefusal | null> {
  if (!(await isEnforced(companyId, documentType))) return null;

  const document = await resolveApprovalDocument(companyId, documentType, documentId);
  const check = await checkApproval(companyId, documentType, documentId, document.amount);
  const rule = check.matchedRule;
  if (!rule) return null;
  const demanded = requiredRank(rule.approverRole);

  // An unbound row (rule_id NULL, no snapshot) proves no rank and cannot clear.
  const approved = (await sql`
    SELECT ar.id, ar.document_digest, COALESCE(ar.required_role, rl.approver_role) AS effective_required_role
    FROM approval_requests ar
    LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
    WHERE ar.company_id = ${companyId} AND ar.document_type = ${documentType}
      AND ar.document_id = ${documentId}::UUID AND ar.status = 'approved'
    ORDER BY ar.decided_at DESC NULLS LAST, ar.id
  `) as Row[];
  const ranked = approved.filter((r) =>
    r.effective_required_role != null && requiredRank(String(r.effective_required_role)) >= demanded);
  const current = document.digest;
  if (current !== null && ranked.some((r) => r.document_digest === current)) return null;

  const refusal = (reason: ApprovalGateReason, requestId: string | null): ApprovalGateRefusal => ({
    reason, requestId, requiredRole: rule.approverRole, ruleName: rule.name,
    documentType, documentReference: document.reference,
  });
  if (check.existingRequest) return refusal('APPROVAL_PENDING', check.existingRequest.id);
  // Approved at a sufficient rank, but for content the document no longer has.
  if (ranked[0]) return refusal('APPROVAL_STALE', String(ranked[0].id));
  return refusal('APPROVAL_REQUIRED', null);
}

/** Throws ApprovalRequiredError unless the gate clears the document. */
export async function assertApprovalCleared(
  companyId: string,
  documentType: DocumentType,
  documentId: string,
): Promise<void> {
  const refusal = await evaluateApprovalGate(companyId, documentType, documentId);
  if (refusal) throw new ApprovalRequiredError(refusal);
}
