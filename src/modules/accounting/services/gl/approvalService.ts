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
import { mapRule, mapRequest, isConditionOperator, CONDITION_OPERATORS } from './approvalMatching';
import { assertMayDemand, assertMayEditRule, auditRuleChange, type RuleActor } from './approvalRuleGuards';
import { lockApprovalRequestForUpdate } from './approvalRequestLock';

// Re-exported so every existing import site keeps working after the
// checkApproval/mapper split that kept this file under the 300-line ceiling.
export { checkApproval, CONDITION_OPERATORS, isConditionOperator } from './approvalMatching';
export type { ConditionOperator } from './approvalMatching';
// requestApproval lives beside the document resolution it is built on; re-exported
// so every existing import site keeps working.
export { requestApproval } from './approvalDocuments';

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
  /**
   * The approver role this request was raised under, snapshot at raise time
   * (migration 669). It ratchets up and never down, so lowering the bound rule
   * — or rebinding the request to a laxer one — cannot weaken a pending request.
   * NULL on rows raised before 669: those are governed by the live rule.
   */
  requiredRole: string | null;
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

export class ApprovalOperatorInvalidError extends Error {
  constructor(operator: string) {
    super(`conditionOperator must be one of: ${CONDITION_OPERATORS.join(', ')} (got ${operator})`);
    this.name = 'ApprovalOperatorInvalidError';
  }
}

/**
 * The only two values `condition_field` may take.
 *
 * checkApproval matches on the resolved document amount and never reads this
 * column, so both of these name the SAME number — the field is descriptive, not
 * a selector. It was neither validated nor evaluated, which made it worse than
 * decorative: the rules page renders `${conditionField} > ${conditionValue}`, so
 * a rule authored as `vat` read as a VAT threshold while it governed the total.
 */
export const CONDITION_FIELDS = ['total', 'amount'] as const;

export class ApprovalFieldInvalidError extends Error {
  constructor(field: string) {
    super(`conditionField must be one of: ${CONDITION_FIELDS.join(', ')} (got ${field})`);
    this.name = 'ApprovalFieldInvalidError';
  }
}

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

/**
 * An operator checkApproval cannot evaluate now fails CLOSED, so writing one
 * makes the rule demand approval on every document of its type. The route used
 * to be the only thing stopping that; any other caller of this module — a
 * script, an MCP tool, the `services/gl/index.ts` re-export — could still write
 * it, and on a database where the CHECK has not landed the column takes it.
 */
function assertConditionOperator(operator: string | undefined): void {
  if (operator !== undefined && !isConditionOperator(operator)) {
    throw new ApprovalOperatorInvalidError(operator);
  }
}

/**
 * Both accepted values mean the document's resolved amount; the column records
 * which word the author used, and nothing branches on it.
 */
function assertConditionField(field: string | undefined): void {
  if (field !== undefined && !(CONDITION_FIELDS as readonly string[]).includes(field)) {
    throw new ApprovalFieldInvalidError(field);
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
}, actor: RuleActor): Promise<ApprovalRule> {
  assertApproverRole(input.approverRole);
  assertConditionOperator(input.conditionOperator);
  assertConditionField(input.conditionField);
  // The rank the NEW rule will demand, defaulted the same way the INSERT does.
  // Without this an admin refused a weakening of the owner-only rule simply
  // creates a manager-level rule beside it and the control is gone.
  assertMayDemand(actor, input.approverRole || 'admin');
  const rows = (await sql`
    INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator, condition_value, approver_role)
    VALUES (
      ${companyId}, ${input.name}, ${input.documentType},
      ${input.conditionField || 'total'}, ${input.conditionOperator || 'greater_than'},
      ${input.conditionValue || 0}, ${input.approverRole || 'admin'}
    ) RETURNING *
  `) as Record<string, unknown>[];
  await auditRuleChange(companyId, actor, 'create', String(rows[0]!.id), null, rows[0]!);
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
}>, actor: RuleActor): Promise<ApprovalRule> {
  assertApproverRole(input.approverRole);
  assertConditionOperator(input.conditionOperator);
  assertConditionField(input.conditionField);
  // Both ends: assertMayEditRule ranks the role the rule demands TODAY, this
  // ranks the one it is being moved to. Ranking only the current role let an
  // admin lower an admin-level rule to `viewer`.
  assertMayDemand(actor, input.approverRole);
  const before = await assertMayEditRule(companyId, id, actor);
  if (!before) throw new ApprovalRuleNotFoundError(id);
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
  if (!rows[0]) throw new ApprovalRuleNotFoundError(id);
  await auditRuleChange(companyId, actor, 'update', id, before, rows[0]);
  return mapRule(rows[0]);
}

/** False when the id names no rule this company owns — the route answers 404. */
export async function deleteRule(companyId: string, id: string, actor: RuleActor): Promise<boolean> {
  const before = await assertMayEditRule(companyId, id, actor);
  if (!before) return false;
  const rows = (await sql`
    DELETE FROM approval_rules WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING id
  `) as Record<string, unknown>[];
  if (!rows[0]) return false;
  await auditRuleChange(companyId, actor, 'delete', id, before, null);
  return true;
}

// ── Approval Requests ────────────────────────────────────────────────────────

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
  // Lock BEFORE the authority is computed, so the row assertMayDecide reads is
  // the row this UPDATE writes. A concurrent rebind can otherwise move the
  // request onto a different rule between the two statements.
  await lockApprovalRequestForUpdate(companyId, requestId);
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
