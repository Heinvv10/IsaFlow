/**
 * Approval rule matching.
 * The operator allowlist, the rule/request row mappers, and checkApproval —
 * split out of approvalService.ts to keep that file under the 300-line ceiling.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { requiredRank } from './approvalAuthority';
import type {
  ApprovalCheckResult, ApprovalRequest, ApprovalRule, ApprovalStatus, DocumentType,
} from './approvalService';

/** The only operators checkApproval can evaluate. Mirrored by the CHECK constraint in 647. */
export const CONDITION_OPERATORS = ['any', 'greater_than', 'greater_equal'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export const isConditionOperator = (value: unknown): value is ConditionOperator =>
  typeof value === 'string' && (CONDITION_OPERATORS as readonly string[]).includes(value);

/** Check if a document requires approval based on active rules */
export async function checkApproval(
  companyId: string,
  documentType: DocumentType,
  documentId: string,
  amount: number
): Promise<ApprovalCheckResult> {
  // Check for existing pending request
  // `effective_required_role` is the authority the row demands TODAY: its own
  // snapshot, or — for a row raised before migration 669 — the bound rule's live
  // role, which is exactly the authority such a row has always carried. The
  // rebind ranks the incoming rule against this, so it can only ratchet upwards.
  const existing = (await sql`
    SELECT ar.*, rl.name AS rule_name,
           COALESCE(ar.required_role, rl.approver_role) AS effective_required_role
    FROM approval_requests ar
    LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
    WHERE ar.company_id = ${companyId}
      AND ar.document_type = ${documentType}
      AND ar.document_id = ${documentId}::UUID
      AND ar.status = 'pending'
    LIMIT 1
  `) as Record<string, unknown>[];

  // The existing request does NOT short-circuit the match. Returning it with no
  // matched rule made the first request for a document pin its own authority:
  // the caller of this function had nothing to compare the stored binding
  // against, so a request raised under a laxer rule stayed governed by it.
  const existingRequest = existing.length > 0 ? mapRequest(existing[0]!) : null;

  // A batch is also judged by every member's own supplier_payment rule (D1).
  const matched = documentType === 'payment_batch'
    ? await strictestBatchRule(companyId, documentId, amount)
    : await strictestMatchingRule(companyId, documentType, amount);

  return {
    requiresApproval: matched !== null || existingRequest !== null,
    matchedRule: matched,
    existingRequest,
  };
}

/**
 * The STRICTEST active rule of the company matching a document of this type
 * and amount, or null. Also what an unattended creator asks BEFORE it inserts
 * a bill it would approve (approvalUnattended.ts), when no document id exists.
 */
export async function strictestMatchingRule(
  companyId: string,
  documentType: DocumentType,
  amount: number
): Promise<ApprovalRule | null> {
  return pickStrictest(await activeRules(companyId, documentType), amount, companyId);
}

/**
 * A payment batch's governing rule (Hein, 2026-10-06, D1): the strictest of its
 * own payment_batch rules on the batch amount AND every member's
 * supplier_payment rules on that member's amount — a one-line batch must not
 * be a laxer way to pay a bill than the payment itself. On a tie in rank the
 * batch's own rule is kept. The SQL twin is approval_payment_batch_strictest_rank
 * (migration 867); r035-pr5-coupling holds them to each other.
 */
export async function strictestBatchRule(
  companyId: string,
  batchId: string,
  batchAmount: number
): Promise<ApprovalRule | null> {
  let matched = await strictestMatchingRule(companyId, 'payment_batch', batchAmount);
  const members = (await sql`
    SELECT DISTINCT approval_supplier_payment_gate_amount(total_amount) AS amount
    FROM supplier_payments WHERE batch_id = ${batchId}::UUID AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  if (members.length === 0) return matched;
  const rules = await activeRules(companyId, 'supplier_payment');
  for (const m of members) {
    const r = pickStrictest(rules, Number(m.amount), companyId);
    if (r && (matched === null || requiredRank(r.approverRole) > requiredRank(matched.approverRole))) matched = r;
  }
  return matched;
}

async function activeRules(companyId: string, documentType: DocumentType): Promise<Record<string, unknown>[]> {
  // The ORDER BY is the tiebreak, not the decision: `priority` is INTEGER
  // DEFAULT 100 and no write path sets it, so every rule a company can create
  // ties, and without created_at/id the winner was heap order.
  return (await sql`
    SELECT * FROM approval_rules
    WHERE company_id = ${companyId}
      AND document_type = ${documentType}
      AND is_active = true
    ORDER BY priority ASC, created_at ASC, id ASC
  `) as Record<string, unknown>[];
}

function pickStrictest(rules: Record<string, unknown>[], amount: number, companyId: string): ApprovalRule | null {

  // The STRICTEST matching rule governs, not the first one found. Ordering alone
  // is not enough for a separation-of-duties control: whichever rule wins decides
  // the approver_role, so "first match" let a laxer rule created beside an
  // owner-only one shadow it — in whichever direction the tiebreak happened to
  // run. Ties in rank fall back to the deterministic order above.
  let matched: ApprovalRule | null = null;
  for (const rule of rules) {
    const r = mapRule(rule);
    let matches = false;

    switch (r.conditionOperator) {
      case 'any':
        matches = true;
        break;
      case 'greater_than':
        matches = amount > r.conditionValue;
        break;
      case 'greater_equal':
        matches = amount >= r.conditionValue;
        break;
      default:
        // A rule written before migration 647 can carry an operator this switch
        // cannot evaluate. Fail closed — an unreadable rule demands approval
        // rather than silently letting the document through.
        log.warn('Approval rule has an unrecognised condition_operator; requiring approval', {
          ruleId: r.id, companyId, conditionOperator: r.conditionOperator,
        }, 'accounting');
        matches = true;
        break;
    }

    if (matches && (matched === null || requiredRank(r.approverRole) > requiredRank(matched.approverRole))) {
      matched = r;
    }
  }

  return matched;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

export function mapRule(r: Record<string, unknown>): ApprovalRule {
  return {
    id: String(r.id),
    name: String(r.name),
    documentType: String(r.document_type) as DocumentType,
    conditionField: String(r.condition_field),
    conditionOperator: String(r.condition_operator),
    conditionValue: Number(r.condition_value),
    approverRole: String(r.approver_role),
    isActive: Boolean(r.is_active),
    priority: Number(r.priority),
    createdAt: String(r.created_at),
  };
}

export function mapRequest(r: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(r.id),
    ruleId: r.rule_id != null ? String(r.rule_id) : null,
    ruleName: r.rule_name ? String(r.rule_name) : undefined,
    // checkApproval resolves the fallback in SQL; every other reader sees the
    // stored snapshot, which is NULL only on rows predating migration 669.
    requiredRole: r.effective_required_role != null
      ? String(r.effective_required_role)
      : r.required_role != null ? String(r.required_role) : null,
    documentType: String(r.document_type) as DocumentType,
    documentId: String(r.document_id),
    documentReference: r.document_reference != null ? String(r.document_reference) : null,
    amount: r.amount ? Number(r.amount) : null,
    documentDigest: r.document_digest != null ? String(r.document_digest) : null,
    status: String(r.status) as ApprovalStatus,
    requestedBy: String(r.requested_by),
    requestedByName: r.requested_by_name ? String(r.requested_by_name) : undefined,
    requestedAt: String(r.requested_at),
    decidedBy: r.decided_by != null ? String(r.decided_by) : null,
    decidedByName: r.decided_by_name ? String(r.decided_by_name) : undefined,
    decidedAt: r.decided_at != null ? String(r.decided_at) : null,
    decisionNotes: r.decision_notes != null ? String(r.decision_notes) : null,
  };
}
