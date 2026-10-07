/**
 * What switching approval enforcement on would hold now (R-035 PR2): the
 * "would block N bills" hint beside the Enforce switch.
 *
 * Per enforceable type. Supplier invoices: bills not yet in the AP population
 * (draft, pending approval; not soft-deleted) that an active rule matches on
 * the amount the gate sees (approval_supplier_invoice_gate_amount /
 * approval_supplier_invoice_rule_matches,
 * the SQL copy the backstop trigger reads), and that no approval decided under
 * the CURRENT enforcement clears for their current content. While enforcement
 * is off that is every matching unposted bill: switching on voids earlier
 * approvals (the gate honours only those decided since `enabled_at`). The rank
 * ratchet is not applied — a hint, not the gate.
 *
 * Credit notes (PR3), the same count per type: draft notes of that type an
 * active rule of that type matches on approval_credit_note_gate_amount, through
 * the generic approval_rule_matches the credit-note backstop reads.
 *
 * Customer invoices (PR4): draft and pending-approval invoices, not
 * soft-deleted, an active rule matches on approval_customer_invoice_gate_amount
 * — the same matcher and amount the customer-invoice backstop reads.
 *
 * Supplier payments and payment batches (PR5): single payments and batches
 * not yet paid (draft or approved — process re-checks the approval) an
 * active rule matches on the gate amount the 867 backstop reads; a batch
 * also when a member's supplier_payment rule matches it (D1, coupled).
 *
 * Manual journals (PR6): DRAFT journals an active rule matches on
 * approval_manual_journal_gate_amount — the post route gates any draft a
 * person posts, whatever created it, so every draft counts.
 */
import { sql } from '@/lib/neon';
import type { DocumentType } from './approvalService';

type Count = { n: number }[];

async function creditNotesHeld(companyId: string, noteType: 'customer' | 'supplier',
  documentType: DocumentType): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n
    FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.type = ${noteType} AND cn.status = 'draft'
      AND approval_rule_matches(
        cn.company_id, ${documentType}::TEXT,
        approval_credit_note_gate_amount(cn.total_amount, cn.subtotal, cn.tax_amount))
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests ar
        JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
        WHERE ar.company_id = cn.company_id AND ar.document_type = ${documentType}::TEXT
          AND ar.document_id = cn.id AND ar.status = 'approved' AND ar.decided_at >= ae.enabled_at
          AND ar.document_digest = approval_document_digest(cn.company_id, ${documentType}::TEXT, cn.id))
  `) as Count;
  return Number(rows[0]?.n ?? 0);
}

async function customerInvoicesHeld(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID AND ci.deleted_at IS NULL
      AND COALESCE(ci.status, '') IN ('draft', 'pending_approval')
      AND approval_rule_matches(
        ci.company_id, 'customer_invoice',
        approval_customer_invoice_gate_amount(ci.total_amount, ci.functional_total))
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests ar
        JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
        WHERE ar.company_id = ci.company_id AND ar.document_type = 'customer_invoice'
          AND ar.document_id = ci.id AND ar.status = 'approved' AND ar.decided_at >= ae.enabled_at
          AND ar.document_digest = approval_document_digest(ci.company_id, 'customer_invoice', ci.id))
  `) as Count;
  return Number(rows[0]?.n ?? 0);
}

async function paymentsHeld(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n
    FROM supplier_payments sp
    WHERE sp.company_id = ${companyId}::UUID AND sp.batch_id IS NULL AND sp.status IN ('draft', 'approved')
      AND approval_rule_matches(sp.company_id, 'supplier_payment', approval_supplier_payment_gate_amount(sp.total_amount))
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests ar
        JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
        WHERE ar.company_id = sp.company_id AND ar.document_type = 'supplier_payment'
          AND ar.document_id = sp.id AND ar.status = 'approved' AND ar.decided_at >= ae.enabled_at
          AND ar.document_digest = approval_document_digest(sp.company_id, 'supplier_payment', sp.id))
  `) as Count;
  return Number(rows[0]?.n ?? 0);
}

async function batchesHeld(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n
    FROM supplier_payment_batches b
    WHERE b.company_id = ${companyId}::UUID AND b.status IN ('draft', 'approved')
      AND approval_payment_batch_strictest_rank(b.company_id, b.id) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests ar
        JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
        WHERE ar.company_id = b.company_id AND ar.document_type = 'payment_batch'
          AND ar.document_id = b.id AND ar.status = 'approved' AND ar.decided_at >= ae.enabled_at
          AND ar.document_digest = approval_document_digest(b.company_id, 'payment_batch', b.id))
  `) as Count;
  return Number(rows[0]?.n ?? 0);
}

async function journalsHeld(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID AND je.status = 'draft'
      AND approval_rule_matches(je.company_id, 'manual_journal', approval_manual_journal_gate_amount(je.company_id, je.id))
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests ar
        JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
        WHERE ar.company_id = je.company_id AND ar.document_type = 'manual_journal'
          AND ar.document_id = je.id AND ar.status = 'approved' AND ar.decided_at >= ae.enabled_at
          AND ar.document_digest = approval_document_digest(je.company_id, 'manual_journal', je.id))
  `) as Count;
  return Number(rows[0]?.n ?? 0);
}

export async function previewEnforcement(companyId: string): Promise<Partial<Record<DocumentType, number>>> {
  const rows = (await sql`
    SELECT count(*)::INT AS n
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
      AND COALESCE(si.status, '') IN ('draft', 'pending_approval')
      AND approval_supplier_invoice_rule_matches(
        si.company_id, approval_supplier_invoice_gate_amount(si.total_amount, si.functional_total))
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests ar
        JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
        WHERE ar.company_id = si.company_id AND ar.document_type = 'supplier_invoice'
          AND ar.document_id = si.id AND ar.status = 'approved' AND ar.decided_at >= ae.enabled_at
          AND ar.document_digest = approval_document_digest(si.company_id, 'supplier_invoice', si.id))
  `) as Count;
  return {
    supplier_invoice: Number(rows[0]?.n ?? 0),
    customer_credit_note: await creditNotesHeld(companyId, 'customer', 'customer_credit_note'),
    supplier_credit_note: await creditNotesHeld(companyId, 'supplier', 'supplier_credit_note'),
    customer_invoice: await customerInvoicesHeld(companyId),
    supplier_payment: await paymentsHeld(companyId),
    payment_batch: await batchesHeld(companyId),
    manual_journal: await journalsHeld(companyId),
  };
}
