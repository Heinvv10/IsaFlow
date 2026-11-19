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
    + 'the bills linked to it (link_bills_to_purchase_order; counts_as_billed is true for approved / paid / partially_paid bills), goods received notes with their items, filed documents, '
    + 'billed_total (the linked ex-VAT amounts on those bills), outstanding_to_bill and fully_billed (billed_total >= subtotal less 1 cent). '
    + 'closed_under_billed is true when a link call closed the PO and its billed total has since fallen below that (a bill cancelled or unlinked): the PO is NOT reopened by a bill cancel, a person decides. '
    + 'Credit notes do not reduce billed. '
    + 'Billed figures are computed on every read. A line\'s billed quantity and amount come from bill lines linked to that PO line (lines in link_bills_to_purchase_order); a header-only link adds to billed_total only. '
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
