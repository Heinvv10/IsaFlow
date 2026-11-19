/**
 * MCP read tool: get_purchase_order — one PO with its lines (ordered / received / billed, outstanding), linked bills, goods
 * received notes, documents, the billed total and fully_billed. Free. Each list is capped with its total beside it
 * (`DETAIL_CAPS`), so a large PO still fits a client's result limit.
 */
import type { McpTool } from '../types';
import { readPurchaseOrderDetail } from '@/modules/accounting/services/ap/purchaseOrderDetailService';
import { parsePoSelector } from './poBillLinkArgs';
import { NOT_FOUND, guardCastableArgs, ok, toolError } from './toolHelpers';

export const getPurchaseOrderTool: McpTool = {
  name: 'get_purchase_order',
  description:
    'One purchase order by po_id or po_number: header, lines (quantity ordered / received / billed, line_total, amount_billed and what is outstanding to receive and to bill), '
    + 'the bills linked to it (link_bills_to_purchase_order; counts_as_billed is true for approved / paid / partially_paid bills), goods received notes with their items, filed documents, '
    + 'billed_total (the linked ex-VAT amounts on those bills), outstanding_to_bill and fully_billed (billed_total >= subtotal less 1 cent). '
    + 'Billed figures are computed on every read. A line\'s billed quantity and amount come from bill lines linked to that PO line (lines in link_bills_to_purchase_order); a header-only link adds to billed_total only. '
    + 'Lists are capped (lines 150, bills 100, goods received notes 50, documents 50) with lines_total / bills_total / goods_received_notes_total / documents_total beside them.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID; or give po_number' },
      po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const key = parsePoSelector(args, 'arguments');
    if (typeof key === 'string') return toolError(key);
    const bad = guardCastableArgs(args, { uuid: ['po_id'] });
    if (bad) return bad;
    const detail = await readPurchaseOrderDetail(ctx.companyId, key);
    if (!detail) return toolError(NOT_FOUND);
    return ok(detail);
  },
};
