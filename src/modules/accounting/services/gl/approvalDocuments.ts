/**
 * Approval requests, and the server-side resolution of the document each one is
 * raised for.
 *
 * The rule that governs a request is chosen by document TYPE and AMOUNT, so
 * every field either of them is read from has to be a server-known fact about a
 * real row. While `amount` arrived in the request body the requester still chose
 * their own governing rule — an admin posting `amount: 1` for a R500 000 supplier
 * invoice landed on the manager rule and had it cleared by a manager — and while
 * `documentId` was only checked to be a well-formed UUID they could pick the
 * whole candidate set by naming a type the document is not, or no document at
 * all.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ApprovalRequest, ApprovalRule, DocumentType } from './approvalService';
import { checkApproval as checkApprovalRules, mapRequest } from './approvalMatching';
import { ApprovalNotRequiredError, ApprovalRuleNotFoundError } from './approvalAuthority';

/** The id names no document of that type in this company. */
export class ApprovalDocumentNotFoundError extends Error {
  constructor(documentType: string, documentId: string) {
    super(`No ${documentType} ${documentId} exists for this company`);
    this.name = 'ApprovalDocumentNotFoundError';
  }
}

export interface ApprovalDocument {
  /** The amount the rules are matched against, read from the stored row. */
  amount: number;
  /** The document's own number, so the request's reference is not caller text either. */
  reference: string | null;
}

type Row = Record<string, unknown>;

const first = (rows: Row[]): Row | undefined => rows[0];

/**
 * One statement per document type — the table name cannot come from a parameter,
 * and `payment` covers both sides of the ledger, so it looks in each in turn.
 * A journal entry carries no amount column; its size is the sum of its debits.
 */
async function findDocument(
  companyId: string,
  documentType: DocumentType,
  documentId: string
): Promise<Row | undefined> {
  switch (documentType) {
    case 'customer_invoice':
      return first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, invoice_number AS reference
        FROM customer_invoices WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    case 'supplier_invoice':
      return first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, invoice_number AS reference
        FROM supplier_invoices WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    case 'credit_note':
      return first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, credit_note_number AS reference
        FROM credit_notes WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    case 'payment': {
      const customer = first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, payment_number AS reference
        FROM customer_payments WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
      if (customer) return customer;
      return first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, payment_number AS reference
        FROM supplier_payments WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    }
    case 'journal_entry':
      return first((await sql`
        SELECT COALESCE((
                 SELECT SUM(jl.debit) FROM gl_journal_lines jl
                 WHERE jl.journal_entry_id = je.id AND jl.company_id = ${companyId}
               ), 0) AS amount,
               je.entry_number AS reference
        FROM gl_journal_entries je WHERE je.id = ${documentId}::UUID AND je.company_id = ${companyId}
      `) as Row[]);
  }
}

/**
 * Throws when the document does not exist, belongs to another company, or is
 * not of the declared type. Refusing is the whole point: a request that names no
 * real document has no server-known amount, so no rule can be chosen for it.
 */
export async function resolveApprovalDocument(
  companyId: string,
  documentType: DocumentType,
  documentId: string
): Promise<ApprovalDocument> {
  const row = await findDocument(companyId, documentType, documentId);
  if (!row) throw new ApprovalDocumentNotFoundError(documentType, documentId);
  return {
    amount: Number(row.amount ?? 0),
    reference: row.reference != null ? String(row.reference) : null,
  };
}

/**
 * Bring a pending request back onto the rule the CURRENT facts choose.
 *
 * Returning the existing row unconditionally let the FIRST request for a
 * document pin its authority permanently: one raised under a laxer rule stayed
 * governed by that rule even when the document's own amount, re-resolved, chose
 * a stricter one. Re-binding is safe because both inputs are now server-derived
 * — the caller cannot move them — and it is the same binding a fresh request for
 * the document would get.
 */
export async function rebindPendingRequest(
  companyId: string,
  existing: ApprovalRequest,
  matched: ApprovalRule | null,
  document: ApprovalDocument
): Promise<ApprovalRequest> {
  // No active rule governs the document now. The pending request keeps the
  // authority it was raised under rather than being silently freed.
  if (!matched) return existing;
  if (existing.ruleId === matched.id && Number(existing.amount ?? 0) === document.amount) return existing;

  const rows = (await sql`
    UPDATE approval_requests SET
      rule_id = ${matched.id}::UUID,
      amount = ${document.amount}::NUMERIC,
      document_reference = ${document.reference}::TEXT
    WHERE id = ${existing.id}::UUID AND company_id = ${companyId} AND status = 'pending'
    RETURNING *
  `) as Row[];
  // Decided between the read and the write: nothing pending to re-bind.
  if (!rows[0]) return existing;
  log.info('Approval request re-bound to the governing rule', {
    id: existing.id, fromRuleId: existing.ruleId, toRuleId: matched.id,
  }, 'accounting');
  return mapRequest(rows[0]);
}

/** uq_approval_requests_pending losing the race, not a fault. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';

/**
 * Create an approval request for a document.
 *
 * NOTHING the caller sends chooses the governing rule. The rule is matched on
 * the document's TYPE and AMOUNT, so both are read from the stored row: the id
 * must name a real document of that type in this company, and its amount and
 * reference come from that row. A caller-supplied `ruleId` let the requester
 * nominate the rule outright; a caller-supplied `amount` did the same thing by
 * dropping the strict rule out of the candidate set (`amount: 1` for a R500 000
 * invoice bound the request to the manager rule), and an unverified `documentId`
 * let them swap the candidate set entirely by declaring a type the document is
 * not — or no document at all.
 */
export async function requestApproval(companyId: string, input: {
  documentType: DocumentType;
  documentId: string;
  requestedBy: string;
}): Promise<ApprovalRequest> {
  const document = await resolveApprovalDocument(companyId, input.documentType, input.documentId);
  const check = await checkApprovalRules(companyId, input.documentType, input.documentId, document.amount);
  // One pending request per document — enforced by uq_approval_requests_pending
  // (migration 665), not just by this read. Returning it is idempotent, but it is
  // re-bound to the rule TODAY's facts choose first: an existing row governed by
  // a laxer rule used to pin the document's authority permanently.
  if (check.existingRequest) {
    return rebindPendingRequest(companyId, check.existingRequest, check.matchedRule, document);
  }
  if (!check.matchedRule) throw new ApprovalNotRequiredError(input.documentType, input.documentId);
  const matchedRule = check.matchedRule;

  // INSERT ... SELECT so the rule's ownership is part of the write itself: a rule
  // belonging to another company matches no row and nothing is inserted. The FK
  // alone does not help — a foreign-key check bypasses RLS and is global.
  // `is_active` is re-checked because checkApproval only considered active rules:
  // one deactivated in between must not be bound to a new request.
  const insert = async () => (await sql`
    INSERT INTO approval_requests (company_id, rule_id, document_type, document_id, document_reference, amount, requested_by)
    SELECT ${companyId}::UUID, rl.id, ${input.documentType}::TEXT, ${input.documentId}::UUID,
           ${document.reference}::TEXT, ${document.amount}::NUMERIC,
           ${input.requestedBy}::UUID
    FROM approval_rules rl
    WHERE rl.id = ${matchedRule.id}::UUID AND rl.company_id = ${companyId} AND rl.is_active = true
    RETURNING *
  `) as Record<string, unknown>[];

  let rows: Record<string, unknown>[];
  try {
    rows = await withSavepoint('approval_request_insert', insert);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent POST won the race. Re-read and return that row, re-bound the
    // same way — two pending rows under different rules was itself a way to
    // choose the rule.
    const raced = await checkApprovalRules(companyId, input.documentType, input.documentId, document.amount);
    if (!raced.existingRequest) throw error;
    return rebindPendingRequest(companyId, raced.existingRequest, raced.matchedRule, document);
  }
  if (!rows[0]) throw new ApprovalRuleNotFoundError(matchedRule.id);
  log.info('Approval requested', {
    id: rows[0]!.id,
    documentType: input.documentType,
    documentId: input.documentId,
    ruleId: matchedRule.id,
  }, 'accounting');
  return mapRequest(rows[0]!);
}
