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
import type { ApprovalRequest, DocumentType } from './approvalService';
import { checkApproval as checkApprovalRules, mapRequest } from './approvalMatching';
import { ApprovalNotRequiredError, ApprovalRuleNotFoundError } from './approvalAuthority';
import { rebindPendingRequest } from './approvalRebind';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { ApprovalDocumentNotFoundError, ApprovalRequestStaleError } from './approvalDocumentErrors';
import { insertRequestRow, raiseRefusal } from './approvalRequestWrites';

export { ApprovalDocumentNotFoundError } from './approvalDocumentErrors';

export interface ApprovalDocument {
  /** The amount the rules are matched against, read from the stored row. */
  amount: number;
  /** The document's own number, so the request's reference is not caller text either. */
  reference: string | null;
  /**
   * approval_document_digest() — WHAT an approval of this document vouches for
   * (migration 708). NULL for a type with no digest definition yet, and a NULL
   * digest never clears the approval gate.
   */
  digest: string | null;
}

type Row = Record<string, unknown>;

const first = (rows: Row[]): Row | undefined => rows[0];

/**
 * One statement per document type — the table name cannot come from a parameter,
 * and the legacy `payment` covers both sides of the ledger, so it looks in each in turn.
 * A journal entry carries no amount column; its size is the sum of its debits.
 *
 * `digest` is approval_document_digest() — the one SQL definition — read in
 * the same statement as the amount.
 *
 * A soft-deleted invoice (`deleted_at` set) is no document: not found.
 *
 * Invoices are matched on their FUNCTIONAL (ZAR) total where they carry one:
 * `total_amount` is in the document's own currency, so a USD 5 000 bill
 * (about R92 500) slipped under a R50 000 rule. A supplier invoice is matched
 * on the LARGER of the two (approval_supplier_invoice_gate_amount, migration
 * 712): its approval posts total_amount, so an exchange rate must not shrink it.
 * A customer invoice likewise (approval_customer_invoice_gate_amount, migration
 * 865) — a change, in R-035 PR4, from its functional total alone, which only
 * ever widens what a rule sees: approveCustomerInvoice posts total_amount
 * unconverted too.
 */
async function findDocument(
  companyId: string,
  documentType: DocumentType,
  documentId: string
): Promise<Row | undefined> {
  switch (documentType) {
    case 'customer_invoice':
      return first((await sql`
        SELECT approval_customer_invoice_gate_amount(total_amount, functional_total) AS amount,
               invoice_number AS reference,
               approval_document_digest(company_id, 'customer_invoice', id) AS digest
        FROM customer_invoices WHERE id = ${documentId}::UUID AND company_id = ${companyId} AND deleted_at IS NULL
      `) as Row[]);
    case 'supplier_invoice':
      return first((await sql`
        SELECT approval_supplier_invoice_gate_amount(total_amount, functional_total) AS amount,
               invoice_number AS reference,
               approval_document_digest(company_id, 'supplier_invoice', id) AS digest
        FROM supplier_invoices WHERE id = ${documentId}::UUID AND company_id = ${companyId} AND deleted_at IS NULL
      `) as Row[]);
    case 'credit_note':
      return first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, credit_note_number AS reference,
               approval_document_digest(company_id, 'credit_note', id) AS digest
        FROM credit_notes WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    // R-035 PR3: a note is found only under the type its own `type` column
    // names. A mismatch is NOT FOUND — otherwise a requester picks the other
    // type's (possibly laxer) rules for it. The amount is the largest leg the
    // approve posts (approval_credit_note_gate_amount, migration 862).
    case 'customer_credit_note':
      return first((await sql`
        SELECT approval_credit_note_gate_amount(total_amount, subtotal, tax_amount) AS amount,
               credit_note_number AS reference,
               approval_document_digest(company_id, 'customer_credit_note', id) AS digest
        FROM credit_notes WHERE id = ${documentId}::UUID AND company_id = ${companyId} AND type = 'customer'
      `) as Row[]);
    case 'supplier_credit_note':
      return first((await sql`
        SELECT approval_credit_note_gate_amount(total_amount, subtotal, tax_amount) AS amount,
               credit_note_number AS reference,
               approval_document_digest(company_id, 'supplier_credit_note', id) AS digest
        FROM credit_notes WHERE id = ${documentId}::UUID AND company_id = ${companyId} AND type = 'supplier'
      `) as Row[]);
    // R-035 PR5 (migration 867): a SINGLE payment only — a batch member is not
    // found under supplier_payment (its approval is its batch's); a batch on the
    // larger of its stored total and its members' sum (the journal posts the first).
    case 'supplier_payment':
      return first((await sql`
        SELECT approval_supplier_payment_gate_amount(total_amount) AS amount, payment_number AS reference,
               approval_document_digest(company_id, 'supplier_payment', id) AS digest
        FROM supplier_payments WHERE id = ${documentId}::UUID AND company_id = ${companyId} AND batch_id IS NULL
      `) as Row[]);
    case 'payment_batch':
      return first((await sql`
        SELECT approval_payment_batch_gate_amount(company_id, id) AS amount, batch_number AS reference,
               approval_document_digest(company_id, 'payment_batch', id) AS digest
        FROM supplier_payment_batches WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    case 'payment': {
      const customer = first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, payment_number AS reference,
               approval_document_digest(company_id, 'payment', id) AS digest
        FROM customer_payments WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
      if (customer) return customer;
      return first((await sql`
        SELECT COALESCE(total_amount, 0) AS amount, payment_number AS reference,
               approval_document_digest(company_id, 'payment', id) AS digest
        FROM supplier_payments WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    }
    // R-035 PR6 (migration 869): any journal of the company — the UI post
    // route gates whatever draft a person posts, whatever created it. Matched
    // on approval_manual_journal_gate_amount: the larger side of its lines.
    case 'manual_journal':
      return first((await sql`
        SELECT approval_manual_journal_gate_amount(company_id, id) AS amount, entry_number AS reference,
               approval_document_digest(company_id, 'manual_journal', id) AS digest
        FROM gl_journal_entries WHERE id = ${documentId}::UUID AND company_id = ${companyId}
      `) as Row[]);
    case 'journal_entry':
      return first((await sql`
        SELECT COALESCE((
                 SELECT SUM(jl.debit) FROM gl_journal_lines jl
                 WHERE jl.journal_entry_id = je.id AND jl.company_id = ${companyId}
               ), 0) AS amount,
               je.entry_number AS reference,
               approval_document_digest(je.company_id, 'journal_entry', je.id) AS digest
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
    digest: row.digest != null ? String(row.digest) : null,
  };
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
  // R-035 PR2-must (4): under Login-as the requester would be recorded as the
  // TARGET, and the real one pushed into past_requesters. Raising is refused.
  await assertNotImpersonating();
  // A stricter rule (or a new amount) between the read below and the write is
  // refused by the definer (RA010) with nothing written; re-reading once binds
  // the rule that governs now. A second race is the 409 the route answers.
  try {
    return await raiseOnce(companyId, input);
  } catch (error) {
    if (!(error instanceof ApprovalRequestStaleError)) throw error;
    log.info('Approval request raced a rule change; raising again', {
      documentType: input.documentType, documentId: input.documentId,
    }, 'accounting');
    return raiseOnce(companyId, input);
  }
}

async function raiseOnce(companyId: string, input: {
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
    return rebindPendingRequest(companyId, check.existingRequest, check.matchedRule, document, input.requestedBy);
  }
  if (!check.matchedRule) throw new ApprovalNotRequiredError(input.documentType, input.documentId);
  const matchedRule = check.matchedRule;

  // approval_request_raise (migration 872) is the only way a request is
  // inserted: it re-checks the rule is this company's, active and the
  // strictest governing the document, binds the requester to the session
  // user, and computes the amount, reference, digest, `content_authors`
  // (approvalAuthors) and `approver_roster` (Q2's snapshot, while enforced)
  // itself. No row: the rule was deactivated in between.
  const insert = async () => insertRequestRow(
    companyId, input.documentType, input.documentId, matchedRule.id, input.requestedBy);

  let rows: Record<string, unknown>[];
  try {
    rows = await withSavepoint('approval_request_insert', insert);
  } catch (error) {
    if (!isUniqueViolation(error)) throw raiseRefusal(error, input.documentType, input.documentId);
    // A concurrent POST won the race. Re-read and return that row, re-bound the
    // same way — two pending rows under different rules was itself a way to
    // choose the rule.
    const raced = await checkApprovalRules(companyId, input.documentType, input.documentId, document.amount);
    if (!raced.existingRequest) throw error;
    return rebindPendingRequest(companyId, raced.existingRequest, raced.matchedRule, document, input.requestedBy);
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
