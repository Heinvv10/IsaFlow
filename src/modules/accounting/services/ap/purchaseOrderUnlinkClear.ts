/**
 * What `unlinkBillFromPurchaseOrder` does around clearing a bill's references to one PO beyond the link row itself (design
 * docs/design/mcp-po-maintenance.md, round 6):
 *   - (whether the unlink raises committed is measured by the unlink itself since PR #1703 breaker r6 A3: `poCommittedCents` before
 *     and after, under the PO lock; the per-bill guesses that stood here are gone);
 *   - `resetMatchState`: the bill's stored three-way state (`match_status`, each line's `line_match_status` / variances) would be stale
 *     once a reference is gone. A bill that still names a PO is re-judged by the existing recompute (`performThreeWayMatch`, in its own
 *     savepoint so a failure cannot poison the unlink); one that names none, or is deleted, is reset to 'unmatched'.
 *   - `auditBillCleared`: one audit row on the BILL naming what was cleared, beside the PO's.
 * Company-scoped; supplier_invoice_items has no company_id (tenancy goes through the bill).
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import { performThreeWayMatch } from './supplierInvoiceWorkflowService';

export async function resetMatchState(companyId: string, billId: string): Promise<'recomputed' | 'reset'> {
  const bill = ((await sql`
    SELECT purchase_order_id, deleted_at,
           EXISTS (SELECT 1 FROM supplier_invoice_items x WHERE x.supplier_invoice_id = si.id AND x.po_item_id IS NOT NULL) AS has_lines
      FROM supplier_invoices si WHERE si.id = ${billId}::UUID AND si.company_id = ${companyId}::UUID
  `) as DbRow[])[0];
  const names = bill && bill.deleted_at == null && (bill.purchase_order_id != null || bill.has_lines === true);
  if (names) {
    try {
      await withSavepoint('unlink_match_recompute', () => performThreeWayMatch(companyId, billId));
      return 'recomputed';
    } catch (err) {
      log.warn('Three-way recompute after an unlink failed; the match state is reset instead', { billId, error: err }, 'accounting');
    }
  }
  await sql`
    UPDATE supplier_invoice_items sii SET line_match_status = 'unmatched', qty_variance_pct = NULL, price_variance_pct = NULL, match_computed_at = NULL
      FROM supplier_invoices si WHERE si.id = sii.supplier_invoice_id AND si.id = ${billId}::UUID AND si.company_id = ${companyId}::UUID
  `;
  await sql`UPDATE supplier_invoices SET match_status = 'unmatched' WHERE id = ${billId}::UUID AND company_id = ${companyId}::UUID`;
  return 'reset';
}

export interface BillCleared {
  poNumber: string; poId: string; invoiceNumber: string; linkRemoved: boolean; linesCleared: number; headerCleared: boolean;
  reason: string; via: string; billStatus: string; match: string;
}

export async function auditBillCleared(companyId: string, userId: string, billId: string, c: BillCleared): Promise<void> {
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'supplier_invoice', entityId: billId, entityRef: c.invoiceNumber.slice(0, 100),
    changes: {
      fields: [],
      metadata: {
        unlinked_from_po: c.poNumber.slice(0, 100), purchase_order_id: c.poId, link_removed: String(c.linkRemoved), lines_cleared: String(c.linesCleared),
        header_cleared: String(c.headerCleared), bill_status: c.billStatus, match_state: c.match, reason: c.reason.slice(0, 500), source: c.via,
      },
    },
  });
}
