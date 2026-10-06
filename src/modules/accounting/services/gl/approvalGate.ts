/**
 * The approval gate: the one check every posting path consults before a
 * document enters the ledger or a subledger population (R-035).
 *
 * Wired for supplier invoices since PR2 (approveSupplierInvoice, the MCP
 * approve pre-reads, the unattended creators), for both credit-note types
 * since PR3 (approveCreditNote, the MCP approve pre-reads) and for customer
 * invoices since PR4 (approveCustomerInvoice, the MCP finalize pre-reads, the
 * recurring runs); other types follow one PR each,
 * as they join ENFORCEABLE_DOCUMENT_TYPES (approvalEnforcement.ts).
 *
 * A document is CLEARED when any of these holds:
 *   - enforcement is off for (company, type);
 *   - no active rule of the company matches it;
 *   - an APPROVED request exists for it, in this company, whose digest is the
 *     document's CURRENT digest, whose demanded role ranks at least as high
 *     as the strictest rule matching today (the ratchet: a manager approval
 *     does not clear once an owner rule governs), and which was DECIDED at or
 *     after enforcement was switched on (`approval_enforcement.enabled_at`) —
 *     an approval taken while the control was off, or before a disable and
 *     re-enable, clears nothing.
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
import type { ApprovalState, DocumentApprovalState } from '../../types/approval.types';

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
  customer_credit_note: 'Customer credit note',
  supplier_credit_note: 'Supplier credit note',
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

export type { ApprovalState, DocumentApprovalState };

const STATE_OF: Record<ApprovalGateReason, ApprovalState> = {
  APPROVAL_REQUIRED: 'required', APPROVAL_PENDING: 'pending', APPROVAL_STALE: 'stale',
};

type Outcome =
  | { enforced: false }
  | { enforced: true; rule: null }
  | { enforced: true; rule: { approverRole: string; name: string }; refusal: ApprovalGateRefusal | null; approvedId: string | null };

async function gateOutcome(companyId: string, documentType: DocumentType, documentId: string): Promise<Outcome> {
  if (!(await isEnforced(companyId, documentType))) return { enforced: false };

  const document = await resolveApprovalDocument(companyId, documentType, documentId);
  const check = await checkApproval(companyId, documentType, documentId, document.amount);
  const rule = check.matchedRule;
  if (!rule) return { enforced: true, rule: null };
  const demanded = requiredRank(rule.approverRole);

  // An unbound row (rule_id NULL, no snapshot) proves no rank and cannot clear.
  // Only approvals decided since enforcement was (last) switched on count.
  const approved = (await sql`
    SELECT ar.id, ar.document_digest, COALESCE(ar.required_role, rl.approver_role) AS effective_required_role
    FROM approval_requests ar
    JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
    LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
    WHERE ar.company_id = ${companyId} AND ar.document_type = ${documentType}
      AND ar.document_id = ${documentId}::UUID AND ar.status = 'approved'
      AND ar.decided_at >= ae.enabled_at
    ORDER BY ar.decided_at DESC NULLS LAST, ar.id
  `) as Row[];
  const ranked = approved.filter((r) =>
    r.effective_required_role != null && requiredRank(String(r.effective_required_role)) >= demanded);
  const current = document.digest;
  const match = current !== null ? ranked.find((r) => r.document_digest === current) : undefined;
  if (match) return { enforced: true, rule, refusal: null, approvedId: String(match.id) };

  const refusal = (reason: ApprovalGateReason, requestId: string | null): ApprovalGateRefusal => ({
    reason, requestId, requiredRole: rule.approverRole, ruleName: rule.name,
    documentType, documentReference: document.reference,
  });
  if (check.existingRequest) return { enforced: true, rule, approvedId: null, refusal: refusal('APPROVAL_PENDING', check.existingRequest.id) };
  // Approved at a sufficient rank, but for content the document no longer has.
  if (ranked[0]) return { enforced: true, rule, approvedId: null, refusal: refusal('APPROVAL_STALE', String(ranked[0].id)) };
  return { enforced: true, rule, approvedId: null, refusal: refusal('APPROVAL_REQUIRED', null) };
}

/** Read-only. Null when the document may be posted, else why not. */
export async function evaluateApprovalGate(
  companyId: string,
  documentType: DocumentType,
  documentId: string,
): Promise<ApprovalGateRefusal | null> {
  const outcome = await gateOutcome(companyId, documentType, documentId);
  return outcome.enforced && outcome.rule ? outcome.refusal : null;
}

/** Read-only. The gate's answer, including the cleared cases a refusal cannot express. */
export async function describeApprovalGate(
  companyId: string,
  documentType: DocumentType,
  documentId: string,
): Promise<DocumentApprovalState> {
  const outcome = await gateOutcome(companyId, documentType, documentId);
  if (!outcome.enforced || !outcome.rule) {
    return { state: 'not_required', enforced: outcome.enforced, requiredRole: null, ruleName: null, requestId: null };
  }
  const { rule, refusal } = outcome;
  return {
    state: refusal ? STATE_OF[refusal.reason] : 'approved',
    enforced: true,
    requiredRole: rule.approverRole,
    ruleName: rule.name,
    requestId: refusal ? refusal.requestId : outcome.approvedId,
  };
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
