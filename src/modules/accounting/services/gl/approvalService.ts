/**
 * Approval Workflow Service
 * Configurable approval rules for financial documents.
 * Checks if documents require approval before processing.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  assertMayDecide, isApproverRole, APPROVER_ROLES,
  ApprovalRuleNotFoundError, ApprovalRequestNotFoundError,
} from './approvalAuthority';
import { mapRule, mapRequest } from './approvalMatching';

// Re-exported so every existing import site keeps working after the
// checkApproval/mapper split that kept this file under the 300-line ceiling.
export { checkApproval, CONDITION_OPERATORS, isConditionOperator } from './approvalMatching';
export type { ConditionOperator } from './approvalMatching';

// ── Types ────────────────────────────────────────────────────────────────────

export type DocumentType = 'customer_invoice' | 'supplier_invoice' | 'payment' | 'journal_entry' | 'credit_note';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalRule {
  id: string;
  name: string;
  documentType: DocumentType;
  conditionField: string;
  conditionOperator: string;
  conditionValue: number;
  approverRole: string;
  isActive: boolean;
  priority: number;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  /** Nullable on the live schema; rows predating the scoped insert can carry NULL. */
  ruleId: string | null;
  ruleName?: string;
  documentType: DocumentType;
  documentId: string;
  documentReference: string | null;
  amount: number | null;
  status: ApprovalStatus;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName?: string;
  decidedAt: string | null;
  decisionNotes: string | null;
}

export interface ApprovalCheckResult {
  requiresApproval: boolean;
  matchedRule: ApprovalRule | null;
  existingRequest: ApprovalRequest | null;
}

// ── Rule CRUD ────────────────────────────────────────────────────────────────

export class ApprovalRoleInvalidError extends Error {
  constructor(role: string) {
    super(`approverRole must be one of: ${APPROVER_ROLES.join(', ')} (got ${role})`);
    this.name = 'ApprovalRoleInvalidError';
  }
}

/**
 * An approver_role the rank ladder does not know silently means 'admin', so a
 * typed 'Owner' would quietly weaken an owner-only rule. Refuse it at the source.
 */
function assertApproverRole(role: string | undefined): void {
  if (role !== undefined && !isApproverRole(role)) {
    throw new ApprovalRoleInvalidError(role);
  }
}

export async function listRules(companyId?: string): Promise<ApprovalRule[]> {
  if (!companyId) return [];
  const rows = (await sql`
    SELECT * FROM approval_rules WHERE company_id = ${companyId} ORDER BY priority ASC, name ASC
  `) as Record<string, unknown>[];
  return rows.map(mapRule);
}

export async function createRule(companyId: string, input: {
  name: string;
  documentType: DocumentType;
  conditionField?: string;
  conditionOperator?: string;
  conditionValue?: number;
  approverRole?: string;
}): Promise<ApprovalRule> {
  assertApproverRole(input.approverRole);
  const rows = (await sql`
    INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator, condition_value, approver_role)
    VALUES (
      ${companyId}, ${input.name}, ${input.documentType},
      ${input.conditionField || 'total'}, ${input.conditionOperator || 'greater_than'},
      ${input.conditionValue || 0}, ${input.approverRole || 'admin'}
    ) RETURNING *
  `) as Record<string, unknown>[];
  log.info('Created approval rule', { id: rows[0]!.id, name: input.name }, 'accounting');
  return mapRule(rows[0]!);
}

export async function updateRule(companyId: string, id: string, input: Partial<{
  name: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: number;
  approverRole: string;
  isActive: boolean;
}>): Promise<ApprovalRule> {
  assertApproverRole(input.approverRole);
  const rows = (await sql`
    UPDATE approval_rules SET
      name = COALESCE(${input.name ?? null}, name),
      condition_field = COALESCE(${input.conditionField ?? null}, condition_field),
      condition_operator = COALESCE(${input.conditionOperator ?? null}, condition_operator),
      condition_value = COALESCE(${input.conditionValue ?? null}, condition_value),
      approver_role = COALESCE(${input.approverRole ?? null}, approver_role),
      is_active = COALESCE(${input.isActive ?? null}, is_active),
      updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error(`Rule ${id} not found`);
  return mapRule(rows[0]);
}

export async function deleteRule(companyId: string, id: string): Promise<void> {
  await sql`DELETE FROM approval_rules WHERE id = ${id}::UUID AND company_id = ${companyId}`;
}

// ── Approval Requests ────────────────────────────────────────────────────────

/** Create an approval request for a document */
export async function requestApproval(companyId: string, input: {
  ruleId: string;
  documentType: DocumentType;
  documentId: string;
  documentReference?: string;
  amount?: number;
  requestedBy: string;
}): Promise<ApprovalRequest> {
  // INSERT ... SELECT so the rule's ownership is part of the write itself: a rule
  // belonging to another company matches no row and nothing is inserted. The FK
  // alone does not help — a foreign-key check bypasses RLS and is global.
  const rows = (await sql`
    INSERT INTO approval_requests (company_id, rule_id, document_type, document_id, document_reference, amount, requested_by)
    SELECT ${companyId}::UUID, rl.id, ${input.documentType}::TEXT, ${input.documentId}::UUID,
           ${input.documentReference || null}::TEXT, ${input.amount || null}::NUMERIC,
           ${input.requestedBy}::UUID
    FROM approval_rules rl
    WHERE rl.id = ${input.ruleId}::UUID AND rl.company_id = ${companyId}
    RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new ApprovalRuleNotFoundError(input.ruleId);
  log.info('Approval requested', {
    id: rows[0]!.id,
    documentType: input.documentType,
    documentId: input.documentId,
  }, 'accounting');
  return mapRequest(rows[0]!);
}

/** List approval requests with optional status filter */
export async function listRequests(companyId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
  const rows = status
    ? (await sql`
        SELECT ar.*, rl.name AS rule_name,
               u1.first_name || ' ' || u1.last_name AS requested_by_name,
               u2.first_name || ' ' || u2.last_name AS decided_by_name
        FROM approval_requests ar
        LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
        LEFT JOIN users u1 ON u1.id = ar.requested_by::TEXT
        LEFT JOIN users u2 ON u2.id = ar.decided_by::TEXT
        WHERE ar.company_id = ${companyId} AND ar.status = ${status}
        ORDER BY ar.created_at DESC
      `) as Record<string, unknown>[]
    : (await sql`
        SELECT ar.*, rl.name AS rule_name,
               u1.first_name || ' ' || u1.last_name AS requested_by_name,
               u2.first_name || ' ' || u2.last_name AS decided_by_name
        FROM approval_requests ar
        LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
        LEFT JOIN users u1 ON u1.id = ar.requested_by::TEXT
        LEFT JOIN users u2 ON u2.id = ar.decided_by::TEXT
        WHERE ar.company_id = ${companyId}
        ORDER BY ar.created_at DESC
      `) as Record<string, unknown>[];
  return rows.map(mapRequest);
}

/** Approve or reject a request */
export async function decideRequest(companyId: string, 
  requestId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  notes?: string
): Promise<ApprovalRequest> {
  await assertMayDecide(companyId, requestId, decidedBy);
  const rows = (await sql`
    UPDATE approval_requests SET
      status = ${decision},
      decided_by = ${decidedBy}::UUID,
      decided_at = NOW(),
      decision_notes = ${notes || null}
    WHERE id = ${requestId}::UUID AND company_id = ${companyId} AND status = 'pending'
    RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new ApprovalRequestNotFoundError(requestId);
  log.info('Approval decided', { id: requestId, decision }, 'accounting');
  return mapRequest(rows[0]);
}

/** Get pending approval count for dashboard badge */
export async function getPendingCount(companyId?: string): Promise<number> {
  if (!companyId) return 0;
  const rows = (await sql`
    SELECT COUNT(*) AS count FROM approval_requests WHERE company_id = ${companyId} AND status = 'pending'
  `) as Record<string, unknown>[];
  return Number(rows[0]?.count ?? 0);
}
