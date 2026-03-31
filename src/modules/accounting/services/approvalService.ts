/**
 * Approval Workflow Service
 * Configurable approval rules for financial documents.
 * Checks if documents require approval before processing.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

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
  ruleId: string;
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

export async function listRules(companyId?: string): Promise<ApprovalRule[]> {
  if (!companyId) return [];
  const rows = (await sql`
    SELECT * FROM approval_rules WHERE company_id = ${companyId} ORDER BY priority ASC, name ASC
  `) as Row[];
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
  const rows = (await sql`
    INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator, condition_value, approver_role)
    VALUES (
      ${companyId}, ${input.name}, ${input.documentType},
      ${input.conditionField || 'total'}, ${input.conditionOperator || 'greater_than'},
      ${input.conditionValue || 0}, ${input.approverRole || 'admin'}
    ) RETURNING *
  `) as Row[];
  log.info('Created approval rule', { id: rows[0].id, name: input.name }, 'accounting');
  return mapRule(rows[0]);
}

export async function updateRule(companyId: string, id: string, input: Partial<{
  name: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: number;
  approverRole: string;
  isActive: boolean;
}>): Promise<ApprovalRule> {
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
  `) as Row[];
  if (!rows[0]) throw new Error(`Rule ${id} not found`);
  return mapRule(rows[0]);
}

export async function deleteRule(companyId: string, id: string): Promise<void> {
  await sql`DELETE FROM approval_rules WHERE id = ${id}::UUID AND company_id = ${companyId}`;
}

// ── Approval Check ───────────────────────────────────────────────────────────

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
    LEFT JOIN approval_rules rl ON rl.id = ar.rule_id
    WHERE ar.company_id = ${companyId}
      AND ar.document_type = ${documentType}
      AND ar.document_id = ${documentId}::UUID
      AND ar.status = 'pending'
    LIMIT 1
  `) as Row[];

  if (existing.length > 0) {
    return {
      requiresApproval: true,
      matchedRule: null,
      existingRequest: mapRequest(existing[0]),
    };
  }

  // Find matching active rules
  const rules = (await sql`
    SELECT * FROM approval_rules
    WHERE company_id = ${companyId}
      AND document_type = ${documentType}
      AND is_active = true
    ORDER BY priority ASC
  `) as Row[];

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
  const rows = (await sql`
    INSERT INTO approval_requests (company_id, rule_id, document_type, document_id, document_reference, amount, requested_by)
    VALUES (
      ${companyId}, ${input.ruleId}::UUID, ${input.documentType}, ${input.documentId}::UUID,
      ${input.documentReference || null}, ${input.amount || null}, ${input.requestedBy}::UUID
    ) RETURNING *
  `) as Row[];
  log.info('Approval requested', {
    id: rows[0].id,
    documentType: input.documentType,
    documentId: input.documentId,
  }, 'accounting');
  return mapRequest(rows[0]);
}

/** List approval requests with optional status filter */
export async function listRequests(companyId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
  const rows = status
    ? (await sql`
        SELECT ar.*, rl.name AS rule_name,
               u1.first_name || ' ' || u1.last_name AS requested_by_name,
               u2.first_name || ' ' || u2.last_name AS decided_by_name
        FROM approval_requests ar
        LEFT JOIN approval_rules rl ON rl.id = ar.rule_id
        LEFT JOIN users u1 ON u1.id = ar.requested_by::TEXT
        LEFT JOIN users u2 ON u2.id = ar.decided_by::TEXT
        WHERE ar.company_id = ${companyId} AND ar.status = ${status}
        ORDER BY ar.created_at DESC
      `) as Row[]
    : (await sql`
        SELECT ar.*, rl.name AS rule_name,
               u1.first_name || ' ' || u1.last_name AS requested_by_name,
               u2.first_name || ' ' || u2.last_name AS decided_by_name
        FROM approval_requests ar
        LEFT JOIN approval_rules rl ON rl.id = ar.rule_id
        LEFT JOIN users u1 ON u1.id = ar.requested_by::TEXT
        LEFT JOIN users u2 ON u2.id = ar.decided_by::TEXT
        WHERE ar.company_id = ${companyId}
        ORDER BY ar.created_at DESC
      `) as Row[];
  return rows.map(mapRequest);
}

/** Approve or reject a request */
export async function decideRequest(companyId: string, 
  requestId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  notes?: string
): Promise<ApprovalRequest> {
  const rows = (await sql`
    UPDATE approval_requests SET
      status = ${decision},
      decided_by = ${decidedBy}::UUID,
      decided_at = NOW(),
      decision_notes = ${notes || null}
    WHERE id = ${requestId}::UUID AND company_id = ${companyId} AND status = 'pending'
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error(`Request ${requestId} not found or already decided`);
  log.info('Approval decided', { id: requestId, decision }, 'accounting');
  return mapRequest(rows[0]);
}

/** Get pending approval count for dashboard badge */
export async function getPendingCount(companyId?: string): Promise<number> {
  if (!companyId) return 0;
  const rows = (await sql`
    SELECT COUNT(*) AS count FROM approval_requests WHERE company_id = ${companyId} AND status = 'pending'
  `) as Row[];
  return Number(rows[0]?.count ?? 0);
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapRule(r: Row): ApprovalRule {
  return {
    id: r.id,
    name: r.name,
    documentType: r.document_type,
    conditionField: r.condition_field,
    conditionOperator: r.condition_operator,
    conditionValue: Number(r.condition_value),
    approverRole: r.approver_role,
    isActive: r.is_active,
    priority: r.priority,
    createdAt: r.created_at,
  };
}

function mapRequest(r: Row): ApprovalRequest {
  return {
    id: r.id,
    ruleId: r.rule_id,
    ruleName: r.rule_name || undefined,
    documentType: r.document_type,
    documentId: r.document_id,
    documentReference: r.document_reference,
    amount: r.amount ? Number(r.amount) : null,
    status: r.status,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name || undefined,
    requestedAt: r.requested_at,
    decidedBy: r.decided_by,
    decidedByName: r.decided_by_name || undefined,
    decidedAt: r.decided_at,
    decisionNotes: r.decision_notes,
  };
}
