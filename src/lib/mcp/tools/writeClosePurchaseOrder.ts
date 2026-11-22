/**
 * MCP write tool: close_purchase_order — short-close a purchase order (design: docs/design/mcp-po-maintenance.md, decision 3):
 * approved / partially_received / received -> closed, reason required, OWNER / ADMIN only (closing releases the commitment: the
 * same rule as close_when_fully_billed). Posts nothing; bills and links stay. The status it came from is recorded (closed_from_status;
 * nothing restores from it yet). The reply lists what was ordered and not received, per line. The role is refused before any read,
 * dry run too. dry_run runs the real service in a rolled-back savepoint and leaves the key free.
 */
import type { McpTool } from '../types';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';
import { closePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderMaintenance';
import {
  dryRunNeedsTx, dryRunResult, isToolResult, parseMaintenanceArgs, REASON_MAX, resolvePoId, runMaintenance,
} from './purchaseOrderMaintenanceArgs';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

const TOOL = 'close_purchase_order';
const LINES_SHOWN = 50;
const r2 = (cents: number) => cents / 100;

export const closePurchaseOrderTool: McpTool = {
  name: TOOL,
  admits: canCancelApprovedPo,
  description:
    'Short-close a purchase order (po_id or po_number): an approved, partially_received or received PO becomes closed, so what was ordered and never received (or never will be) stops counting as committed spend. '
    + 'Owner or admin only (closing releases a commitment). A reason is required and audited with the status it was closed from and the received and billed amounts at that moment. Posts nothing: bills and links to the PO stay. '
    + 'The reply gives, per line that was short-closed, the ordered, received and remaining quantity and the remaining ex-VAT amount. The status it came from is recorded on the PO (get_purchase_order shows closed_from_status); no tool restores from it yet. Closing from partially_received / received also drops goods received and not yet billed from committed spend. A PO closed here commits nothing and no unlink or bill cancel reopens it (unlike one link_bills_to_purchase_order closed as fully billed). '
    + 'Refused for a draft, submitted, already closed or cancelled PO (cancel_purchase_order cancels). dry_run runs every check and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID; or give po_number' },
      po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
      reason: { type: 'string', maxLength: REASON_MAX, description: 'Why it is closed (audited)' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseMaintenanceArgs(args);
    if (typeof parsed === 'string') return toolError(parsed);
    // Closing releases a commitment: the owner's / admin's call, as the link tool's close. Before any read, dry run too.
    if (!canCancelApprovedPo(ctx.companyRole)) return toolError('Closing a purchase order releases its commitment, which only an owner or admin may do.');
    const needsTx = dryRunNeedsTx(parsed.dryRun);
    if (needsTx) return toolError(needsTx);
    const poId = await resolvePoId(ctx.companyId, parsed);
    if (!poId) return toolError(NOT_FOUND);
    const out = await runMaintenance(`${TOOL}_dry`, parsed.dryRun, () => closePurchaseOrder(ctx.companyId, poId, parsed.reason, { userId: ctx.userId, via: `mcp:${TOOL}` }));
    if (isToolResult(out)) return out;
    const r = out.value;
    const body = {
      po_id: r.poId, po_number: r.poNumber, status_before: r.statusBefore, status: r.status, received_amount: r2(r.receivedCents), billed_amount: r2(r.billedCents),
      remaining_amount: r2(r.remainingAmountCents), short_closed_lines_total: r.shortClosed.length,
      short_closed_lines: r.shortClosed.slice(0, LINES_SHOWN).map((l) => ({
        po_item_id: l.poItemId, description: l.description.slice(0, 150), ordered_qty: l.orderedQty, received_qty: l.receivedQty,
        remaining_qty: l.remainingQty, remaining_amount: r2(l.remainingAmountCents),
      })),
      short_closed_lines_truncated: r.shortClosed.length > LINES_SHOWN,
    };
    return parsed.dryRun ? dryRunResult({ would_close: true, ...body }) : ok({ closed: true, ...body });
  },
};
