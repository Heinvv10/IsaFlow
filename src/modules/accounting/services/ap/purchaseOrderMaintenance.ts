/**
 * cancel_purchase_order and close_purchase_order (design docs/design/mcp-po-maintenance.md, decisions 2 and 3). Post nothing.
 * Each runs in one savepoint under the PO row `FOR UPDATE` (5 s, `PURCHASE_ORDER_LOCK_TIMEOUT`); no budget gate: releasing a
 * commitment cannot overspend. Every refusal is a `PurchaseOrderMaintenanceRefusal` raised before the write; both are audited.
 * The ROLE rules are the tool's (a manager may cancel a draft; only an owner or admin closes, or cancels an approved PO).
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { toCents } from '../budgets/grid/cents';
import { cancelApprovedPurchaseOrder } from './purchaseOrderCancel';
import { billedCentsByPo } from './purchaseOrderBilled';
import { PurchaseOrderChangedError, PurchaseOrderMaintenanceRefusal, PurchaseOrderNotFoundError } from './purchaseOrderErrors';
import { lockPoForMaintenance, receiptOrLinkRefusal } from './purchaseOrderMaintenanceGuards';

export interface MaintenanceOptions { userId: string; via: string; /** May the caller cancel an approved PO (owner / admin). */ mayCancelApproved?: boolean }

export interface CancelResult { poId: string; poNumber: string; statusBefore: string; status: 'cancelled' }

const refuse = (m: string) => new PurchaseOrderMaintenanceRefusal(m);
const statusWords = (s: string) => s.replace(/_/g, ' ');

export async function cancelPurchaseOrder(companyId: string, poId: string, reason: string, opts: MaintenanceOptions): Promise<CancelResult> {
  const why = reason.trim();
  if (why === '') throw refuse('Give a reason to cancel a purchase order');
  return withSavepoint('cancel_purchase_order_mcp', async () => {
    const po = await lockPoForMaintenance(companyId, poId);
    if (!po) throw new PurchaseOrderNotFoundError();
    const done: CancelResult = { poId, poNumber: po.poNumber, statusBefore: po.status, status: 'cancelled' };
    if (po.status === 'approved') {
      if (opts.mayCancelApproved !== true) throw refuse('Cancelling an approved purchase order releases its commitment, which only an owner or admin may do');
      // The same wide receipt / bill-tie check as the draft path (a bill line naming a PO line counts, not only a link row), then the
      // existing action: it refuses with a receipt and with link rows too, and audits with the reason.
      const tied = await receiptOrLinkRefusal(companyId, poId, 'it cannot be cancelled');
      if (tied) throw refuse(tied);
      await cancelApprovedPurchaseOrder(companyId, poId, opts.userId, why, opts.via);
      return done;
    }
    if (po.status !== 'draft' && po.status !== 'submitted') {
      throw refuse(po.status === 'cancelled' ? 'This purchase order is already cancelled'
        : `A ${statusWords(po.status)} purchase order cannot be cancelled${po.status === 'closed' ? '' : ' (goods have been received against it)'}`);
    }
    const blocked = await receiptOrLinkRefusal(companyId, poId, 'it cannot be cancelled');
    if (blocked) throw refuse(blocked);
    const updated = (await sql`
      UPDATE purchase_orders SET status = 'cancelled', updated_at = NOW(), updated_by = ${opts.userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status IN ('draft', 'submitted') RETURNING id
    `) as DbRow[];
    if (!updated[0]) throw new PurchaseOrderChangedError();
    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: poId, entityRef: po.poNumber.slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: po.status, new: 'cancelled', label: 'Status' }],
        metadata: { cancelled: 'true', reason: why.slice(0, 500), source: opts.via },
      },
    });
    return done;
  });
}

/** The statuses a short close accepts (the ones that commit spend). */
export const CLOSE_FROM_STATUSES: readonly string[] = ['approved', 'partially_received', 'received'];

export interface ShortClosedLine {
  poItemId: string;
  description: string;
  orderedQty: number;
  receivedQty: number;
  remainingQty: number;
  /** Ex-VAT, the line's amount pro rata to the quantity still to come. */
  remainingAmountCents: number;
}

export interface CloseResult {
  poId: string;
  poNumber: string;
  statusBefore: string;
  status: 'closed';
  receivedCents: number;
  billedCents: number;
  shortClosed: ShortClosedLine[];
  remainingAmountCents: number;
}

/** Ordered less received per line, in hundredths of a unit and cents (a line is whole-cent, a quantity has two decimals). */
async function remainingLines(companyId: string, poId: string): Promise<{ lines: ShortClosedLine[]; receivedCents: number }> {
  const rows = (await sql`
    SELECT pi.id::TEXT AS id, pi.description, pi.quantity::TEXT AS quantity, COALESCE(pi.quantity_received, 0)::TEXT AS received, pi.line_total::TEXT AS line_total
      FROM po_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id = ${poId}::UUID ORDER BY pi.sort_order, pi.id
  `) as DbRow[];
  const lines: ShortClosedLine[] = [];
  let receivedCents = 0;
  for (const r of rows) {
    const ordered = Math.round(Number(r.quantity) * 100);
    const got = Math.min(ordered, Math.max(0, Math.round(Number(r.received) * 100)));
    const net = toCents(Number(r.line_total));
    receivedCents += ordered > 0 ? Math.round((net * got) / ordered) : 0;
    if (got >= ordered) continue;
    lines.push({
      poItemId: String(r.id), description: String(r.description), orderedQty: ordered / 100, receivedQty: got / 100, remainingQty: (ordered - got) / 100,
      remainingAmountCents: Math.round((net * (ordered - got)) / ordered),
    });
  }
  return { lines, receivedCents };
}

export async function closePurchaseOrder(companyId: string, poId: string, reason: string, opts: MaintenanceOptions): Promise<CloseResult> {
  const why = reason.trim();
  if (why === '') throw refuse('Give a reason to close a purchase order');
  return withSavepoint('close_purchase_order', async () => {
    const po = await lockPoForMaintenance(companyId, poId);
    if (!po) throw new PurchaseOrderNotFoundError();
    if (!CLOSE_FROM_STATUSES.includes(po.status)) {
      throw refuse(`Only an approved, partially received or received purchase order can be closed (this one is ${statusWords(po.status)})`);
    }
    const { lines, receivedCents } = await remainingLines(companyId, poId);
    const billedCents = (await billedCentsByPo(companyId, [poId])).get(poId) ?? 0;
    const updated = (await sql`
      UPDATE purchase_orders SET status = 'closed', closed_from_status = ${po.status}, updated_at = NOW(), updated_by = ${opts.userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status = ${po.status} RETURNING id
    `) as DbRow[];
    if (!updated[0]) throw new PurchaseOrderChangedError();
    const remainingAmountCents = lines.reduce((s, l) => s + l.remainingAmountCents, 0);
    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: poId, entityRef: po.poNumber.slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: po.status, new: 'closed', label: 'Status' }],
        metadata: {
          closed: 'true', short_close: 'true', reason: why.slice(0, 500), source: opts.via, status_before: po.status,
          received_amount: (receivedCents / 100).toFixed(2), billed_amount: (billedCents / 100).toFixed(2),
          remaining_amount: (remainingAmountCents / 100).toFixed(2), short_closed_lines: String(lines.length),
        },
      },
    });
    return { poId, poNumber: po.poNumber, statusBefore: po.status, status: 'closed', receivedCents, billedCents, shortClosed: lines, remainingAmountCents };
  });
}
