/**
 * Approval rule matching.
 * The operator allowlist, the rule/request row mappers, and checkApproval —
 * split out of approvalService.ts to keep that file under the 300-line ceiling.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  ApprovalCheckResult, ApprovalRequest, ApprovalRule, ApprovalStatus, DocumentType,
} from './approvalService';

/** The only operators checkApproval can evaluate. Mirrored by the CHECK constraint in 632. */
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
  const existing = (await sql`
    SELECT ar.*, rl.name AS rule_name
    FROM approval_requests ar
    LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
    WHERE ar.company_id = ${companyId}
      AND ar.document_type = ${documentType}
      AND ar.document_id = ${documentId}::UUID
      AND ar.status = 'pending'
    LIMIT 1
  `) as Record<string, unknown>[];

  if (existing.length > 0) {
    return {
      requiresApproval: true,
      matchedRule: null,
      existingRequest: mapRequest(existing[0]!),
    };
  }

  // Find matching active rules
  const rules = (await sql`
    SELECT * FROM approval_rules
    WHERE company_id = ${companyId}
      AND document_type = ${documentType}
      AND is_active = true
    ORDER BY priority ASC
  `) as Record<string, unknown>[];

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
        // A rule written before migration 632 can carry an operator this switch
        // cannot evaluate. Fail closed — an unreadable rule demands approval
        // rather than silently letting the document through.
        log.warn('Approval rule has an unrecognised condition_operator; requiring approval', {
          ruleId: r.id, companyId, conditionOperator: r.conditionOperator,
        }, 'accounting');
        matches = true;
        break;
    }

    if (matches) {
      return {
        requiresApproval: true,
        matchedRule: r,
        existingRequest: null,
      };
    }
  }

  return { requiresApproval: false, matchedRule: null, existingRequest: null };
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
    ruleId: String(r.rule_id),
    ruleName: r.rule_name ? String(r.rule_name) : undefined,
    documentType: String(r.document_type) as DocumentType,
    documentId: String(r.document_id),
    documentReference: r.document_reference != null ? String(r.document_reference) : null,
    amount: r.amount ? Number(r.amount) : null,
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
