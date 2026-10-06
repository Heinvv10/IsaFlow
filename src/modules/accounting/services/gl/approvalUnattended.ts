/**
 * The approval gate for paths that approve a document with nobody deciding at
 * that moment (R-035 PR2, design B1, B2, A6, A4/A5).
 *
 * Capture post and the AI invoice pipeline INSERT an auto-approved bill
 * straight as 'approved', and a recurring autoPost template approves the bill
 * it has just minted. None of them may REFUSE when a rule governs the bill —
 * the captured document is already claimed, and a refusal would strand it —
 * so each inserts (or leaves) the bill a DRAFT and raises the approval request
 * itself, as the person who ran it. Under Login-as nothing is raised (raising
 * is refused there, PR2-must 4): the bill stays a draft with the approval
 * still required, which the detail page shows.
 *
 * An agent (MCP) may neither raise nor decide an approval (decision Q6); its
 * approve tools refuse or skip, from a read, with the text below.
 */

import { log } from '@/lib/logger';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import type { ApprovalRequest, DocumentType } from './approvalService';
import { strictestMatchingRule } from './approvalMatching';
import { isEnforced } from './approvalEnforcement';
import { requestApproval } from './approvalDocuments';
import { ApprovalRequiredError, evaluateApprovalGate } from './approvalGate';

/**
 * The status an unattended creator may INSERT a new bill with. `amount` is the
 * functional (ZAR) figure the rules will see — the bill's total when it
 * carries no functional_total. `gated` means: insert a draft, then call
 * raiseUnattendedApproval once its lines are written.
 */
export async function unattendedBillStatus(companyId: string, wantsApproved: boolean, amount: number):
  Promise<{ status: 'approved' | 'draft'; gated: boolean }> {
  if (!wantsApproved) return { status: 'draft', gated: false };
  const gated = (await isEnforced(companyId, 'supplier_invoice'))
    && (await strictestMatchingRule(companyId, 'supplier_invoice', amount)) !== null;
  return { status: gated ? 'draft' : 'approved', gated };
}

/** Raise the request as `requestedBy`; null (nothing raised) under Login-as. */
export async function raiseUnattendedApproval(companyId: string, documentType: DocumentType,
  documentId: string, requestedBy: string): Promise<ApprovalRequest | null> {
  if (await currentSessionActor() === 'impersonation') {
    log.warn('Approval required but not raised: Login-as session', { companyId, documentType, documentId }, 'accounting');
    return null;
  }
  return requestApproval(companyId, { documentType, documentId, requestedBy });
}

/** An agent's refusal for a gated document, or null when the gate clears it. */
export async function agentApprovalRefusal(companyId: string, documentType: DocumentType,
  documentId: string): Promise<string | null> {
  const refusal = await evaluateApprovalGate(companyId, documentType, documentId);
  if (!refusal) return null;
  return `${new ApprovalRequiredError(refusal).message} This connector cannot raise or decide approvals: `
    + 'a person must submit it for approval in IsaFlow and an eligible approver must approve it.';
}

/** agentApprovalRefusal for a batch: id → `approval_required: <why>`, for the gated ones only. */
export async function agentApprovalRefusals(companyId: string, documentType: DocumentType,
  documentIds: readonly string[]): Promise<Map<string, string>> {
  const refusals = new Map<string, string>();
  for (const id of documentIds) {
    const refusal = await agentApprovalRefusal(companyId, documentType, id);
    if (refusal) refusals.set(id, `approval_required: ${refusal}`);
  }
  return refusals;
}

/**
 * An agent about to CREATE a supplier payment and pay it in the same call
 * (MCP settle_by_contra, R-035 PR5). The gate cannot be read for a payment
 * that does not exist yet, and one created and then refused would be left
 * half-made — so the call is refused up front, from reads, when supplier
 * payments are enforced and an active rule matches the amount the payment
 * would carry (approval_supplier_payment_gate_amount: its absolute value).
 * The agent could neither raise nor decide the approval it needs (Q6).
 */
export async function agentNewSupplierPaymentRefusal(companyId: string, amount: number): Promise<string | null> {
  if (!(await isEnforced(companyId, 'supplier_payment'))) return null;
  const rule = await strictestMatchingRule(companyId, 'supplier_payment', Math.abs(amount));
  if (!rule) return null;
  return `Supplier payments are enforced: a payment of R${Math.abs(amount).toFixed(2)} needs ${rule.approverRole} approval `
    + `before it can be paid (rule: ${rule.name}). This connector cannot raise or decide approvals: a person must record `
    + 'the settlement in IsaFlow, submit it for approval, and an eligible approver must approve it.';
}
