/**
 * MCP write tool: unlink_bill_from_purchase_order — undo one link made by link_bills_to_purchase_order (or the app).
 * Deletes the link, clears the bill's line links into that PO, resets the bill's single-PO header and reopens the PO to
 * the status it had when THIS link's call closed it (if it is still closed). Posts nothing. A reason is required and
 * audited. dry_run runs the real service in a rolled-back savepoint. Same locks as the link tool.
 */
import type { McpTool } from '../types';
import { als } from '@/lib/als';
import { UUID_RE } from '@/lib/validation';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { unlinkBillFromPurchaseOrder, type UnlinkResult } from '@/modules/accounting/services/ap/purchaseOrderBillUnlink';
import { PurchaseOrderBillLinkRefusal } from '@/modules/accounting/services/ap/purchaseOrderBillLinkTypes';
import { mayReadBudgetFigures } from './budgetFigures';
import { parsePoSelector } from './poBillLinkArgs';
import { ok, toolError } from './toolHelpers';

const TOOL = 'unlink_bill_from_purchase_order';
const REASON_MAX = 500;

export const unlinkBillFromPurchaseOrderTool: McpTool = {
  name: TOOL,
  description:
    'Remove every tie between one bill and one purchase order: the ONE exit for what update_purchase_order / cancel_purchase_order / set_purchase_order_status tell you to unlink first. Posts nothing; any bill status (draft, cancelled too). '
    + 'It succeeds when ANY of these exists, and clears all of them in one write: the link, po_item_id on the bill\'s lines that point into this PO\'s lines (a line with no link row counts: a R0 line, a draft or cancelled bill\'s line), and the bill\'s purchase_order_id when it names this PO; it is refused "not linked" only when none does. '
    + 'Deletes the link, clears po_item_id on that bill\'s lines that point into this PO '
    + '(so budget committed for those PO lines is no longer netted by the bill), resets the bill\'s purchase_order_id when it named this PO (to its PO when exactly one other link remains, else none; a header that names another PO stays as it is) '
    + 'and reopens the PO to the status a link call closed it from (close_when_fully_billed) when it is still closed and no longer fully billed after the unlink '
    + '(the record of that closing moves to another link of the PO when this link held it and the PO is still fully billed; a PO closed by hand is left). '
    + 'Un-netting PO lines or reopening makes the PO commit spend again: the budget check runs in warn form and never blocks; an over-budget result comes back as budget_warning (nothing is recorded in the budget history). Any write:invoices holder may unlink and so reopen a PO that a link closed: reopening restores a commitment, the conservative direction. '
    + 'A reason is required and recorded in the audit trail. Refused when the bill has no link, no line and no header reference to this PO. dry_run runs every check and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID; or give po_number' },
      po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
      bill_id: { type: 'string', description: 'Supplier invoice UUID' },
      reason: { type: 'string', maxLength: REASON_MAX, description: 'Why the link is removed (audited)' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['bill_id', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const po = parsePoSelector(args, 'arguments');
    if (typeof po === 'string') return toolError(po);
    if (typeof args.bill_id !== 'string' || !UUID_RE.test(args.bill_id)) return toolError('bill_id must be a supplier invoice UUID');
    if (typeof args.reason !== 'string' || args.reason.trim() === '') return toolError('reason is required: say why the link is removed');
    if (args.reason.trim().length > REASON_MAX) return toolError(`reason is longer than ${REASON_MAX} characters`);
    if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return toolError('dry_run must be true or false');
    const dryRun = args.dry_run === true;
    if (dryRun && !als.getStore()?.client) return toolError('dry_run needs a request transaction');
    const opts = { userId: ctx.userId, via: `mcp:${TOOL}`, budgetFigures: mayReadBudgetFigures(ctx) };
    const req = { ...po, billId: args.bill_id.toLowerCase(), reason: args.reason };

    let result: UnlinkResult | undefined;
    try {
      if (dryRun) await inRolledBackSavepoint('po_bill_unlink_dry', async () => { result = await unlinkBillFromPurchaseOrder(ctx.companyId, req, opts); });
      else result = await unlinkBillFromPurchaseOrder(ctx.companyId, req, opts);
    } catch (err) {
      if (err instanceof PurchaseOrderBillLinkRefusal) return toolError(err.message);
      throw err;
    }
    const r = result!;
    const body = {
      link_id: r.linkId, link_removed: r.linkId !== null, header_cleared: r.headerCleared, purchase_order_id: r.poId, po_number: r.poNumber, bill_id: r.billId, invoice_number: r.invoiceNumber,
      amount: r.amountCents / 100, lines_cleared: r.linesCleared, po_status_before: r.poStatusBefore, po_status: r.poStatusAfter,
      reopened_to: r.reopenedTo, billed: r.billedCents / 100, fully_billed: r.fullyBilled,
      budget_warning: r.budgetWarnings.length > 0 ? r.budgetWarnings.join(' ') : null, budget_warnings: r.budgetWarnings,
    };
    if (dryRun) {
      const preview = ok({ dry_run: true, would_unlink: true, ...body });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }
    return ok({ unlinked: true, ...body });
  },
};
