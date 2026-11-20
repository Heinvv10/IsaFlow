/**
 * MCP write tool: cancel_goods_received — cancel a goods received note with a reason (design: docs/design/mcp-goods-received.md).
 * The note becomes cancelled (kept, never deleted), its quantities come back off the PO lines and the PO status is recomputed.
 * POSTS NOTHING. Refused: already_cancelled, po_not_receivable (the PO is closed or cancelled), grn_on_bill (a bill that is neither
 * deleted nor cancelled carries the note; the bills are named; cancelling or deleting them frees it), not_found. Managers and above (the write fence). dry_run runs the real service in
 * a rolled-back savepoint and leaves the key free. Free (purchaseOrderFlow).
 */
import type { McpTool } from '../types';
import { CANCEL_REASON_MAX, cancelGoodsReceived } from '@/modules/accounting/services/ap/goodsReceivedCancel';
import { grnDryRunNeedsTx, grnDryRunResult, isGrnToolResult, runGrn } from './goodsReceivedArgs';
import { ok, toolError } from './toolHelpers';
import { UUID_RE } from '@/lib/validation';

const TOOL = 'cancel_goods_received';
const KEYS = new Set(['grn_id', 'reason', 'dry_run', 'idempotency_key']);

export const cancelGoodsReceivedTool: McpTool = {
  name: TOOL,
  description:
    'Cancel a goods received note (grn_id) with a reason (required; recorded in the audit trail and on the note). The note is kept with status cancelled; '
    + 'each of its quantity_received comes back off its purchase order line, and the PO status is recomputed (received -> partially_received or approved). '
    + 'Posts NOTHING to the general ledger (a goods received note never posts). Committed spend is unchanged. '
    + 'Refused (JSON {refused, code, message}): already_cancelled; po_not_receivable when the PO is closed or cancelled (set its status back first); '
    + 'grn_on_bill when a bill that is neither deleted nor cancelled carries this note (the bills are named: cancel or delete those bills first); not_found. '
    + 'Billed quantity above received quantity is allowed after a cancel, as when a bill arrives before the goods. dry_run runs every check and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      grn_id: { type: 'string', description: 'Goods received note UUID (list_goods_received)' },
      reason: { type: 'string', maxLength: CANCEL_REASON_MAX, description: 'Why it is cancelled (audited)' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['grn_id', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const stray = Object.keys(args).find((k) => !KEYS.has(k));
    if (stray !== undefined) return toolError(`arguments.${stray} is not a field of this tool (allowed: ${[...KEYS].join(', ')})`);
    if (typeof args.grn_id !== 'string' || !UUID_RE.test(args.grn_id)) return toolError('grn_id is required: the goods received note UUID (list_goods_received)');
    if (typeof args.reason !== 'string' || args.reason.trim() === '') return toolError('reason is required: say why (it is recorded in the audit trail)');
    if (args.reason.trim().length > CANCEL_REASON_MAX) return toolError(`reason is longer than ${CANCEL_REASON_MAX} characters`);
    if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return toolError('dry_run must be true or false');
    const dryRun = args.dry_run === true;
    const needsTx = grnDryRunNeedsTx(dryRun);
    if (needsTx) return toolError(needsTx);
    const grnId = args.grn_id;
    const reason = args.reason;
    const out = await runGrn(`${TOOL}_dry`, dryRun, () => cancelGoodsReceived(ctx.companyId, grnId, reason, { userId: ctx.userId, via: `mcp:${TOOL}` }));
    if (isGrnToolResult(out)) return out;
    const r = out.value;
    const body = {
      grn_id: r.grnId, grn_number: r.grnNumber, status: 'cancelled', purchase_order_id: r.poId, po_number: r.poNumber,
      po_status_before: r.poStatusBefore, po_status: r.poStatusAfter,
      lines: r.items.map((l) => ({ po_item_id: l.poItemId, quantity_received: l.quantityReceived, quantity_rejected: l.quantityRejected })),
      posted_to_ledger: false,
    };
    return dryRun ? grnDryRunResult({ would_cancel: true, ...body }) : ok({ cancelled: true, ...body });
  },
};
