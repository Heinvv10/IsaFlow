/**
 * MCP write tool: create_goods_received — record goods received against an approved / partially received purchase order
 * (design: docs/design/mcp-goods-received.md). It runs `receiveGoods`, the service the app's POST uses, so the rules are the
 * app's. POSTS NOTHING: no GRNI accrual, no stock journal; the ledger moves when the bill is approved. ALL OR NOTHING: every
 * refused line is listed (over_receipt with its outstanding and asked quantities, line_not_on_po, duplicate_line) and nothing
 * is written. external_system + external_ref are unique per company among notes that are not cancelled (duplicate_external_ref
 * names the note holding it). dry_run runs the real service in a rolled-back savepoint, reports grn_number "next" and leaves the
 * key free. Free (purchaseOrderFlow).
 */
import type { McpTool } from '../types';
import { receiveGoods } from '@/modules/accounting/services/ap/goodsReceivedService';
import {
  GRN_TEXT_MAX, MAX_GRN_LINES, grnDryRunNeedsTx, grnDryRunResult, isGrnToolResult, parseCreateGrnArgs, runGrn,
} from './goodsReceivedArgs';
import { ok, toolError } from './toolHelpers';

const TOOL = 'create_goods_received';

export const createGoodsReceivedTool: McpTool = {
  name: TOOL,
  description:
    'Record goods received (a goods received note, GRN-NNNNN) against a purchase order that is approved or partially_received: one line per PO line received, '
    + '{po_item_id (get_purchase_order lines[].id), quantity_received, quantity_rejected?, notes?}. '
    + 'quantity_received may not exceed the line\'s ordered quantity less what was already received (rejected goods do not count against it); each PO line at most once; every line must be on that PO. '
    + 'The PO then becomes partially_received, or received when every line is received in full. '
    + 'Posts NOTHING to the general ledger: no GRNI accrual and no stock journal (the ledger moves when the bill is approved). '
    + 'external_system + external_ref (e.g. "fibreflow" and its delivery id) mark the source delivery: a reference already on a note that is not cancelled is refused as duplicate_external_ref naming that note, and nothing is written; once that note is cancelled the reference can be used again. '
    + 'ALL OR NOTHING: a refusal is JSON {refused, code, message, lines[] (index, po_item_id, code, outstanding, asked)}, codes po_not_receivable, over_receipt, line_not_on_po, duplicate_line, duplicate_external_ref, not_found; nothing is written. '
    + 'dry_run runs every check and writes nothing (grn_number reads "next").',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID (list_purchase_orders / get_purchase_order)' },
      received_date: { type: 'string', format: 'date' },
      received_by: { type: 'string', maxLength: 200, description: 'Who received the goods (default: the connected user)' },
      notes: { type: 'string', maxLength: GRN_TEXT_MAX },
      lines: {
        type: 'array', minItems: 1, maxItems: MAX_GRN_LINES,
        items: {
          type: 'object',
          properties: {
            po_item_id: { type: 'string', description: 'A line of this purchase order' },
            quantity_received: { type: 'number', minimum: 0, description: 'At most two decimals' },
            quantity_rejected: { type: 'number', minimum: 0, description: 'Delivered and refused; does not count as received' },
            notes: { type: 'string', maxLength: GRN_TEXT_MAX },
          },
          required: ['po_item_id', 'quantity_received'],
          additionalProperties: false,
        },
      },
      external_system: { type: 'string', maxLength: 32, description: 'e.g. "fibreflow"; with external_ref' },
      external_ref: { type: ['string', 'integer'], description: 'The source system\'s id for this delivery; with external_system' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['po_id', 'received_date', 'lines', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseCreateGrnArgs(args);
    if (typeof parsed === 'string') return toolError(parsed);
    const needsTx = grnDryRunNeedsTx(parsed.dryRun);
    if (needsTx) return toolError(needsTx);
    const out = await runGrn(`${TOOL}_dry`, parsed.dryRun, () => receiveGoods(ctx.companyId, ctx.userId, parsed.input, {
      via: `mcp:${TOOL}`, external: parsed.external,
    }));
    if (isGrnToolResult(out)) return out;
    const r = out.value;
    const body = {
      grn_id: parsed.dryRun ? null : String(r.receipt.id), grn_number: parsed.dryRun ? 'next' : String(r.receipt.grn_number),
      purchase_order_id: parsed.input.purchaseOrderId, po_number: r.poNumber, po_status_before: r.poStatusBefore, po_status: r.poStatusAfter,
      received_date: parsed.input.receivedDate, external_system: parsed.external?.system ?? null, external_ref: parsed.external?.ref ?? null,
      lines: r.items.map((l) => ({ po_item_id: l.poItemId, quantity_received: l.quantityReceived, quantity_rejected: l.quantityRejected })),
      posted_to_ledger: false,
    };
    return parsed.dryRun ? grnDryRunResult({ would_create: true, ...body }) : ok({ created: true, ...body });
  },
};
