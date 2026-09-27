/**
 * What switching approval enforcement on would hold now (R-035 PR2): the
 * "would block N bills" hint beside the Enforce switch.
 *
 * Supplier invoices only — the one enforceable type. Counted: bills not yet in
 * the AP population (draft, pending approval; not soft-deleted) that an active
 * rule matches on their functional total (approval_supplier_invoice_rule_matches,
 * the SQL copy the backstop trigger reads), and that no approval decided under
 * the CURRENT enforcement clears for their current content. While enforcement
 * is off that is every matching unposted bill: switching on voids earlier
 * approvals (the gate honours only those decided since `enabled_at`). The rank
 * ratchet is not applied — a hint, not the gate.
 */
import { sql } from '@/lib/neon';
import type { DocumentType } from './approvalService';

export async function previewEnforcement(companyId: string): Promise<Partial<Record<DocumentType, number>>> {
  const rows = (await sql`
    SELECT count(*)::INT AS n
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
      AND COALESCE(si.status, '') IN ('draft', 'pending_approval')
      AND approval_supplier_invoice_rule_matches(si.company_id, COALESCE(si.functional_total, si.total_amount, 0))
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests ar
        JOIN approval_enforcement ae ON ae.company_id = ar.company_id AND ae.document_type = ar.document_type
        WHERE ar.company_id = si.company_id AND ar.document_type = 'supplier_invoice'
          AND ar.document_id = si.id AND ar.status = 'approved' AND ar.decided_at >= ae.enabled_at
          AND ar.document_digest = approval_document_digest(si.company_id, 'supplier_invoice', si.id))
  `) as { n: number }[];
  return { supplier_invoice: Number(rows[0]?.n ?? 0) };
}
