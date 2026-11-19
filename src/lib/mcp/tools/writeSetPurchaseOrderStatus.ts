/**
 * MCP write tool: set_purchase_order_status — move an IMPORTED purchase order (one carrying external_ref) to draft | approved |
 * closed | cancelled when its source system moved it (design: docs/design/mcp-po-maintenance.md, decision 4). Posts nothing.
 * OWNER / ADMIN only, reason required, audited old -> new. Refused for a PO with a goods receipt, and for a move that would orphan
 * bill links (-> draft / -> cancelled while linked). -> approved runs the budget check normally (the import's
 * skip_budget_check_for_import does not apply). -> closed records the status it came from. The role is refused before any read,
 * dry run too. dry_run runs the real service in a rolled-back savepoint and leaves the key free.
 */
import type { McpTool } from '../types';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';
import { SETTABLE_PO_STATUSES, setImportedPurchaseOrderStatus, type SettablePoStatus } from '@/modules/accounting/services/ap/purchaseOrderSetStatus';
import { mayReadBudgetFigures } from './budgetFigures';
import {
  dryRunNeedsTx, dryRunResult, isToolResult, parseMaintenanceArgs, REASON_MAX, resolvePoId, runMaintenance,
} from './purchaseOrderMaintenanceArgs';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

const TOOL = 'set_purchase_order_status';

export const setPurchaseOrderStatusTool: McpTool = {
  name: TOOL,
  description:
    'Set the status of a purchase order that was IMPORTED from another system (it carries an external_ref; see bulk_create_purchase_orders) when the source moved it: '
    + `status = ${SETTABLE_PO_STATUSES.join(' | ')} (approved is what the import calls open; closed is what it calls billed). Owner or admin only; a reason is required and audited (old -> new). Posts nothing. `
    + 'Refused for a PO with no external_ref (use update / cancel / close for those), a PO with goods received against it, a received or partially_received one, one already in that status, '
    + 'and a move that would orphan bill links: to draft or cancelled while bills are linked (unlink_bill_from_purchase_order first). '
    + 'approved runs the PO approval budget check normally (block refuses, warn returns budget_warnings) and stamps who approved it; closed records the status it was closed from (as close_purchase_order). '
    + 'dry_run runs every check and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID; or give po_number' },
      po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
      status: { type: 'string', enum: [...SETTABLE_PO_STATUSES], description: 'The status to set.' },
      reason: { type: 'string', maxLength: REASON_MAX, description: 'Why the status is set (audited)' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['status', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseMaintenanceArgs(args, ['status']);
    if (typeof parsed === 'string') return toolError(parsed);
    const target = (SETTABLE_PO_STATUSES as readonly string[]).includes(String(args.status)) ? (args.status as SettablePoStatus) : null;
    if (!target) return toolError(`status must be one of ${SETTABLE_PO_STATUSES.join(', ')}`);
    if (!canCancelApprovedPo(ctx.companyRole)) return toolError('Setting a purchase order status can release or restore a commitment, which only an owner or admin may do.');
    const needsTx = dryRunNeedsTx(parsed.dryRun);
    if (needsTx) return toolError(needsTx);
    const poId = await resolvePoId(ctx.companyId, parsed);
    if (!poId) return toolError(NOT_FOUND);
    const out = await runMaintenance(`${TOOL}_dry`, parsed.dryRun, () => setImportedPurchaseOrderStatus(ctx.companyId, poId, target, parsed.reason, {
      userId: ctx.userId, via: `mcp:${TOOL}`, budgetFigures: mayReadBudgetFigures(ctx),
    }));
    if (isToolResult(out)) return out;
    const r = out.value;
    const body = {
      po_id: r.poId, po_number: r.poNumber, status_before: r.statusBefore, status: r.status, closed_from_status: r.closedFromStatus,
      budget_warning: r.budgetWarnings.length > 0 ? r.budgetWarnings.join(' ') : null, budget_warnings: r.budgetWarnings,
    };
    return parsed.dryRun ? dryRunResult({ would_set: true, ...body }) : ok({ status_set: true, ...body });
  },
};
