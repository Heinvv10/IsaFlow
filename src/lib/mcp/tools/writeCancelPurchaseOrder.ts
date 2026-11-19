/**
 * MCP write tool: cancel_purchase_order — cancel a purchase order, reason required and audited (design:
 * docs/design/mcp-po-maintenance.md, decision 2). Posts nothing. Draft / submitted: any writer (as the app's edit sets
 * cancelled). Approved: owner / admin only (`cancelApprovedPurchaseOrder`: refused with a goods receipt or linked bills). A
 * partially_received, received, closed or already cancelled PO is refused with its status. dry_run runs the real service in a
 * rolled-back savepoint and leaves the key free.
 */
import type { McpTool } from '../types';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';
import { cancelPurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderMaintenance';
import {
  dryRunNeedsTx, dryRunResult, isToolResult, parseMaintenanceArgs, REASON_MAX, resolvePoId, runMaintenance,
} from './purchaseOrderMaintenanceArgs';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

const TOOL = 'cancel_purchase_order';

export const cancelPurchaseOrderTool: McpTool = {
  name: TOOL,
  description:
    'Cancel a purchase order (po_id or po_number) with a reason (required; recorded in the audit trail). Posts nothing; a cancelled PO commits nothing. '
    + 'A draft or submitted one can be cancelled by any writer. An APPROVED one only by an owner or admin, and only while no goods have been received against it and no bill is linked to it (unlink_bill_from_purchase_order first). '
    + 'A partially_received, received, closed or already cancelled purchase order is refused with its status (use close_purchase_order to finish a received / part-received one). '
    + 'dry_run runs every check and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID; or give po_number' },
      po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
      reason: { type: 'string', maxLength: REASON_MAX, description: 'Why it is cancelled (audited)' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseMaintenanceArgs(args);
    if (typeof parsed === 'string') return toolError(parsed);
    const needsTx = dryRunNeedsTx(parsed.dryRun);
    if (needsTx) return toolError(needsTx);
    const poId = await resolvePoId(ctx.companyId, parsed);
    if (!poId) return toolError(NOT_FOUND);
    const out = await runMaintenance(`${TOOL}_dry`, parsed.dryRun, () => cancelPurchaseOrder(ctx.companyId, poId, parsed.reason, {
      userId: ctx.userId, via: `mcp:${TOOL}`, mayCancelApproved: canCancelApprovedPo(ctx.companyRole),
    }));
    if (isToolResult(out)) return out;
    const r = out.value;
    const body = { po_id: r.poId, po_number: r.poNumber, status_before: r.statusBefore, status: r.status };
    return parsed.dryRun ? dryRunResult({ would_cancel: true, ...body }) : ok({ cancelled: true, ...body });
  },
};
