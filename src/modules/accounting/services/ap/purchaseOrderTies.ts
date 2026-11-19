/**
 * The bills that TIE a purchase order, one row per bill (design docs/design/mcp-po-maintenance.md): what the PO maintenance tools
 * refuse on ("unlink it first") and what `get_purchase_order` lists, so a caller can always see which bill to unlink. Every row is
 * cleared by `unlink_bill_from_purchase_order` (the one exit). A bill appears once, under the first kind that applies:
 *   - `link`: a `purchase_order_bill_links` row (a link on a soft-DELETED bill too, flagged `deleted`);
 *   - `line`: a (not deleted) bill line whose `po_item_id` names one of the PO's lines, any bill status: `po_item_id` has no FK;
 *   - `header`: a bill that names the PO ONLY in its header when `link_bills_to_purchase_order` COULD link the pair (PO approved /
 *     partially_received / received / closed; bill approved / paid / partially_paid, not deleted, same supplier). A header the link
 *     tool could not make a link of is not billing the PO and is not a tie.
 * Company-scoped throughout (po_items has no company_id: tenancy goes through the PO / the bill).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { LINKABLE_BILL_STATUSES, LINKABLE_PO_STATUSES } from './purchaseOrderBillLinkTypes';

export type TieKind = 'link' | 'line' | 'header';

export interface PoTies { total: number; rows: DbRow[] }

/** `liveBillLinksOnly`: leave out a link whose bill is CANCELLED, for a guard that does not refuse on one (the approved-PO cancel). */
export interface TieOptions { liveBillLinksOnly?: boolean }

export const ALL_TIE_KINDS: readonly TieKind[] = ['link', 'line', 'header'];

/**
 * The ties, ordered, capped at `limit` with the total. `kinds` narrows the list to the kinds a given guard actually refuses on, so a
 * refusal never names a bill that is not what blocks it. Each branch is DRIVEN FROM THE PO (its po_items through idx_sii_po_item, its
 * header references through idx_si_po, its link rows through the link table's (company, PO) key), so the cost follows the PO's own
 * bills, not the company's.
 */
export async function readPoTies(companyId: string, poId: string, limit: number, kinds: readonly TieKind[] = ALL_TIE_KINDS, opts: TieOptions = {}): Promise<PoTies> {
  const rows = (await sql`
    SELECT t.*, count(*) OVER ()::INT AS total_rows FROM (
      SELECT 'link'::TEXT AS tie, l.id AS link_id, l.amount, l.source, l.external_system, l.external_ref,
             si.id AS bill_id, si.invoice_number, si.status, si.invoice_date, si.subtotal, si.total_amount, (si.deleted_at IS NOT NULL) AS deleted
        FROM purchase_order_bill_links l JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
       WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ${poId}::UUID
         AND (NOT ${opts.liveBillLinksOnly === true}::BOOLEAN OR si.status <> 'cancelled')
      UNION ALL
      SELECT 'line', NULL, NULL, NULL, NULL, NULL, si.id, si.invoice_number, si.status, si.invoice_date, si.subtotal, si.total_amount, false
        FROM supplier_invoices si
       WHERE si.id IN (SELECT sii.supplier_invoice_id FROM po_items pi JOIN supplier_invoice_items sii ON sii.po_item_id = pi.id
                        WHERE pi.purchase_order_id = ${poId}::UUID)
         AND si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM purchase_order_bill_links l WHERE l.company_id = si.company_id AND l.supplier_invoice_id = si.id
                           AND l.purchase_order_id = ${poId}::UUID)
      UNION ALL
      SELECT 'header', NULL, NULL, NULL, NULL, NULL, si.id, si.invoice_number, si.status, si.invoice_date, si.subtotal, si.total_amount, false
        FROM purchase_orders po JOIN supplier_invoices si ON si.purchase_order_id = po.id AND si.company_id = po.company_id
       WHERE po.id = ${poId}::UUID AND po.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
         AND si.supplier_id = po.supplier_id AND si.status = ANY(${[...LINKABLE_BILL_STATUSES]}::TEXT[])
         AND po.status = ANY(${[...LINKABLE_PO_STATUSES]}::TEXT[])
         AND NOT EXISTS (SELECT 1 FROM purchase_order_bill_links l WHERE l.company_id = si.company_id AND l.supplier_invoice_id = si.id
                           AND l.purchase_order_id = ${poId}::UUID)
         AND NOT EXISTS (SELECT 1 FROM po_items pi JOIN supplier_invoice_items sii ON sii.po_item_id = pi.id
                          WHERE pi.purchase_order_id = ${poId}::UUID AND sii.supplier_invoice_id = si.id)
    ) t WHERE t.tie = ANY(${[...kinds]}::TEXT[]) ORDER BY t.invoice_date, t.invoice_number, t.bill_id LIMIT ${limit}
  `) as DbRow[];
  return { total: rows[0] ? Number(rows[0].total_rows) : 0, rows };
}

export const REFUSAL_BILLS_SHOWN = 10;

/** The ONE sentence every tie refusal starts with (update, cancel, set status, supplier change, the app's cancel). */
export const TIE_REFUSAL = 'A bill is linked to or names this purchase order';

/** The whole refusal for a PO whose bill ties are in the way of `what`, or null when none ties it. */
export async function tieRefusalText(companyId: string, poId: string, what: string, kinds: readonly TieKind[] = ALL_TIE_KINDS, opts: TieOptions = {}): Promise<string | null> {
  const ties = await describePoTies(companyId, poId, kinds, opts);
  return ties === null ? null : `${TIE_REFUSAL} [${ties}], so ${what}; unlink it first (unlink_bill_from_purchase_order)`;
}

/** "INV-1 (id …, link); INV-2 (id …, header); and 3 more", or null when nothing ties the PO. */
export async function describePoTies(companyId: string, poId: string, kinds: readonly TieKind[] = ALL_TIE_KINDS, opts: TieOptions = {}): Promise<string | null> {
  const ties = await readPoTies(companyId, poId, REFUSAL_BILLS_SHOWN, kinds, opts);
  if (ties.total === 0) return null;
  const shown = ties.rows.map((r) => `${String(r.invoice_number).slice(0, 60)} (id ${r.bill_id}, ${r.tie}${r.deleted === true ? ', deleted' : ''})`).join('; ');
  return ties.total > ties.rows.length ? `${shown}; and ${ties.total - ties.rows.length} more` : shown;
}
