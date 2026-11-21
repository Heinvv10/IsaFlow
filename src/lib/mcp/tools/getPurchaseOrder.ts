/**
 * MCP read tool: get_purchase_order — one PO with its lines (ordered / received / billed, outstanding), linked bills, goods
 * received notes, documents, the billed total and fully_billed. Free. Each list is capped with its total beside it
 * (`DETAIL_CAPS`), so a large PO still fits a client's result limit.
 */
import type { McpTool } from '../types';
import { DETAIL_CAPS, readPurchaseOrderDetail } from '@/modules/accounting/services/ap/purchaseOrderDetailService';
import { parsePoSelector } from './poBillLinkArgs';
import { OFFSET_SCHEMA, parseOffset } from './pageArgs';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

export const getPurchaseOrderTool: McpTool = {
  name: 'get_purchase_order',
  description:
    'One purchase order by po_id or po_number: header, lines (quantity ordered / received / billed, line_total, amount_billed and what is outstanding to receive and to bill), '
    + 'EVERY bill tying it, one row each with its tie kind: link (a link row, link_bills_to_purchase_order; a link on a deleted bill is listed with deleted: true), line (a bill line names one of its lines, no link row) or header (the bill names it in its purchase_order_id, no link row, and could be linked); unlink_bill_from_purchase_order clears any of them (counts_as_billed is true for approved / paid / partially_paid bills that are not deleted), goods received notes with their items, filed documents, '
    + 'billed_total (what the approved / paid / partially_paid bills hold on this PO, ex VAT: a bill whose lines name the PO holds those lines\' posted amount, else its link\'s amount, else, named only in its header, its subtotal less what it holds on other POs; each bill row shows it as attributed_amount: the bill\'s attribution whether or not it counts, see counts_as_billed; linked_amount is the amount stored on its link row), outstanding_to_bill and fully_billed (billed_total >= subtotal less 1 cent). '
    + 'closed_under_billed is true when the PO was closed because it was fully billed (a link call\'s close_when_fully_billed, or the SPO migration) and its billed total has since fallen below that without an app path reopening it (a bill changed outside the app); an unlink, a bill cancel or a bill delete that leaves it under-billed reopens it. '
    + 'Credit notes do not reduce billed. '
    + 'Billed figures are computed on every read. A line\'s billed quantity and amount come from bill lines linked to that PO line (lines in link_bills_to_purchase_order); a header-only link adds to billed_total only (and nets budget committed over the PO lines). '
    + `Lists are capped (lines ${DETAIL_CAPS.lines}, bills ${DETAIL_CAPS.bills}, goods received notes ${DETAIL_CAPS.grns} with ${DETAIL_CAPS.grnItems} items each (items_total / items_truncated per note), documents ${DETAIL_CAPS.documents}; long text is cut at 150 characters, notes at 500) with lines_total / bills_total / goods_received_notes_total / documents_total beside them; `
    + 'page the lines with offset = the previous reply\'s next_offset (null on the last page).',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID; or give po_number' },
      po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const key = parsePoSelector(args, 'arguments');
    if (typeof key === 'string') return toolError(key);
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const detail = await readPurchaseOrderDetail(ctx.companyId, key, offset);
    if (!detail) return toolError(NOT_FOUND);
    return ok(detail);
  },
};
