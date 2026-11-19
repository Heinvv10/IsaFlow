/**
 * Write side of link_bills_to_purchase_order (design docs/design/mcp-po-bill-links.md): purchase_order_bill_links rows,
 * the bill lines' `po_item_id`, the bill header's `purchase_order_id`, and (close_when_fully_billed) the PO's status.
 * It POSTS NOTHING: no gl_journal_* row, and a bill's status, totals and amount_paid are never touched.
 *
 * Order: read the facts under the locks (`purchaseOrderBillLinkRead`), plan every row (`purchaseOrderBillLinkPlan`:
 * pure), and only when no row is refused write. The refusal is raised before the first write, so the caller (whose
 * savepoint rolls back on a throw) may answer it as a tool error. Anything after the first write rethrows.
 * One audit row per new link (entity purchase_order; the row that closed the PO also records the status change).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { syncBillHeaderPurchaseOrder } from './purchaseOrderBillLinkHeader';
import { planLinks } from './purchaseOrderBillLinkPlan';
import { readLinkFacts } from './purchaseOrderBillLinkRead';
import {
  PurchaseOrderBillLinkRefusal, linkRefusalText, type LinkRequest, type PlannedLink, type PoAfter,
} from './purchaseOrderBillLinkTypes';

export interface LinkOptions {
  userId: string;
  /** 'mcp' for the tool; the audit row names the tool in `via`. */
  source: 'mcp' | 'app';
  via: string;
  closeWhenFullyBilled: boolean;
}

export interface LinkedBill {
  index: number;
  linkId: string;
  poId: string;
  poNumber: string;
  billId: string;
  invoiceNumber: string;
  amountCents: number;
  linesLinked: number;
  alreadyExisted: boolean;
  externalSystem: string | null;
  externalRef: string | null;
}

export interface LinkResult {
  links: LinkedBill[];
  /** One per PO the call names, after the call. */
  purchaseOrders: (PoAfter & { poNumber: string })[];
}

const r2 = (c: number) => (c / 100).toFixed(2);

async function writeLink(companyId: string, p: PlannedLink, opts: LinkOptions): Promise<string> {
  if (p.lineWrites.length > 0) {
    const done = (await sql`
      UPDATE supplier_invoice_items sii SET po_item_id = x.po_item_id
        FROM unnest(${p.lineWrites.map((l) => l.billLineId)}::UUID[], ${p.lineWrites.map((l) => l.poItemId)}::UUID[]) AS x(line_id, po_item_id)
       WHERE sii.id = x.line_id AND sii.supplier_invoice_id = ${p.billId}::UUID AND sii.po_item_id IS NULL
         AND EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID)
      RETURNING sii.id
    `) as DbRow[];
    if (done.length !== p.lineWrites.length) throw new Error('A bill line changed while it was being linked');
  }
  const rows = (await sql`
    INSERT INTO purchase_order_bill_links (
      company_id, purchase_order_id, supplier_invoice_id, amount, source, external_system, external_ref, closed_po_from_status, created_by
    ) VALUES (
      ${companyId}::UUID, ${p.poId}::UUID, ${p.billId}::UUID, ${r2(p.amountCents)}::NUMERIC, ${opts.source},
      ${p.ref?.system ?? null}, ${p.ref?.ref ?? null}, ${p.closedFrom}, ${opts.userId}
    ) RETURNING id
  `) as DbRow[];
  return String(rows[0]!.id);
}

export async function linkBillsToPurchaseOrders(
  companyId: string, requests: readonly LinkRequest[], opts: LinkOptions,
): Promise<LinkResult> {
  const facts = await readLinkFacts(companyId, requests);
  const { plan, refusals } = planLinks({ requests, ...facts, closeWhenFullyBilled: opts.closeWhenFullyBilled });
  if (!plan) throw new PurchaseOrderBillLinkRefusal(linkRefusalText(requests.length, refusals), refusals);

  const links: LinkedBill[] = [];
  const touchedBills = new Set<string>();
  for (const p of plan.planned) {
    const after = plan.poAfter.get(p.poId)!;
    let linkId: string;
    if (p.existing) linkId = p.existing.id;
    else {
      linkId = await writeLink(companyId, p, opts);
      touchedBills.add(p.billId);
      if (p.closedFrom) {
        const closed = (await sql`
          UPDATE purchase_orders SET status = 'closed', updated_at = NOW(), updated_by = ${opts.userId}
           WHERE id = ${p.poId}::UUID AND company_id = ${companyId}::UUID AND status = ${p.closedFrom} RETURNING id
        `) as DbRow[];
        if (closed.length !== 1) throw new Error('The purchase order changed while it was being closed');
      }
      await logAuditOrThrow({
        companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: p.poId, entityRef: p.poNumber.slice(0, 100),
        changes: {
          fields: p.closedFrom ? [{ field: 'status', old: p.closedFrom, new: 'closed', label: 'Status' }] : [],
          metadata: {
            linked_bill: p.invoiceNumber.slice(0, 100), bill_id: p.billId, link_id: linkId, amount: r2(p.amountCents),
            lines_linked: String(p.linesLinked), source: opts.via, fully_billed: String(after.fullyBilled),
            ...(p.ref ? { externalSystem: p.ref.system, externalRef: p.ref.ref } : {}),
          },
        },
      });
    }
    links.push({
      index: p.index, linkId, poId: p.poId, poNumber: p.poNumber, billId: p.billId, invoiceNumber: p.invoiceNumber,
      amountCents: p.amountCents, linesLinked: p.linesLinked, alreadyExisted: p.existing !== null,
      externalSystem: p.ref?.system ?? null, externalRef: p.ref?.ref ?? null,
    });
  }
  await syncBillHeaderPurchaseOrder(companyId, [...touchedBills]);
  return {
    links: links.sort((a, b) => a.index - b.index),
    purchaseOrders: [...plan.poAfter.values()].map((a) => ({ ...a, poNumber: facts.pos.get(a.poId)!.poNumber })),
  };
}
