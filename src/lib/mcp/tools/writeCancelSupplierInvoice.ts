/**
 * MCP write tool: `cancel_supplier_invoice`.
 *
 * Cancels a supplier bill and, when it was approved, reverses its approval
 * journal with a contra entry (both stay in the ledger). Wraps the same
 * `cancelSupplierInvoice` the UI uses, stamped as the agent's posting.
 *
 * Every refusal comes from `planSupplierInvoiceCancel`, from READS, before the
 * cancel runs — and the cancel is called with NO catch. A catch cannot tell a
 * refusal from a failure after the contra posted, and a refusal is audited
 * with a free idempotency key, so a retry could post a second contra.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '@/lib/mcp/contracts';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  SupplierInvoiceCancelRefusal,
  lockAndPlanSupplierInvoiceCancel,
  type SupplierInvoiceCancelPlan,
} from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { mcpPostingOpts } from '../mcpActor';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'cancel_supplier_invoice';

export const cancelSupplierInvoiceTool: McpTool = {
  name: TOOL,
  description:
    'Cancel a supplier bill (supplier invoice). A draft, pending or disputed bill simply becomes '
    + 'cancelled. An APPROVED bill also has its approval journal (DR Expense/VAT, CR Accounts Payable) '
    + 'reversed by a contra entry dated like reverse_journal_entry dates it — the original date when '
    + 'its period is open, otherwise today — and both entries stay in the ledger. '
    + 'Refused, with the reason and the remedy named, when: anything is applied to the bill '
    + '(void_payment / cancel_credit_note first); it is matched to a bank payment '
    + '(reverse_bank_allocation first); a draft or approved payment still plans to pay it; another '
    + 'posted journal sourced from it stands (e.g. a DRC VAT journal — reverse_journal_entry first); '
    + 'its journal is still a draft; it is approved but has NO approval journal to reverse; the '
    + 'reversal would land in a locked VAT period; or it is already cancelled. '
    + 'Cancelling is final: there is no un-cancel; re-enter the bill if needed. '
    + 'Run with dry_run first: it shows the contra journal it would post and writes nothing.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', description: 'The supplier bill, from list_supplier_invoices.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['invoice_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const invoiceId = strArg(args, 'invoice_id');
    if (!invoiceId) return toolError('invoice_id is required');
    const bad = guardCastableArgs(args, { uuid: ['invoice_id'] });
    if (bad) return bad;

    // Planned on the LOCKED row: the cancel below re-locks it (a no-op), so no
    // concurrent payment or approval can move what the plan decided.
    let plan: SupplierInvoiceCancelPlan;
    try {
      plan = await lockAndPlanSupplierInvoiceCancel(ctx.companyId, invoiceId);
    } catch (err) {
      // Reads only: nothing has been written, so a refusal is safe to return.
      if (err instanceof SupplierInvoiceCancelRefusal) return toolError(err.message);
      throw err;
    }

    if (args.dry_run === true) return dryRunResult(plan);

    // No catch — see the header.
    const cancelled = await cancelSupplierInvoice(
      ctx.companyId, invoiceId, ctx.userId, mcpPostingOpts(ctx, TOOL),
    );
    const contra = plan.journal
      ? ((await sql`
          SELECT id, entry_number FROM gl_journal_entries
          WHERE company_id = ${ctx.companyId}::UUID AND reversal_of_id = ${plan.journal.id}::UUID
          ORDER BY created_at DESC, id DESC
          LIMIT 1`) as DbRow[])[0]
      : undefined;
    return ok({
      invoice_id: plan.invoiceId,
      invoice_number: plan.invoiceNumber,
      status_before: plan.status,
      status: cancelled.status,
      journal_reversed: Boolean(plan.journal),
      reversed_journal_entry_id: plan.journal?.id ?? null,
      reversal_journal_entry_id: contra ? String(contra.id) : null,
      reversal_entry_number: contra ? String(contra.entry_number) : null,
      reversal_date: plan.journal?.reversalDate ?? null,
    });
  },
};

/** `wroteNothing` keeps the idempotency key free for the real call. */
function dryRunResult(plan: SupplierInvoiceCancelPlan) {
  const j = plan.journal;
  const result: DryRunResult = {
    dryRun: true,
    journals: j
      ? [{
          date: j.reversalDate,
          description: `Reversal of ${j.entryNumber} (cancel ${plan.invoiceNumber})`,
          fiscalPeriodId: null,
          lines: j.lines,
          totalDebit: j.lines.reduce((s, l) => s + l.debit, 0),
          totalCredit: j.lines.reduce((s, l) => s + l.credit, 0),
        }]
      : [],
    skipped: [],
    effects: [{
      entityType: 'supplier_invoice',
      entityId: plan.invoiceId,
      documentNumber: plan.invoiceNumber,
      field: 'outstanding',
      before: plan.totalAmount,
      after: 0,
    }],
    journalsTotal: j ? 1 : 0,
    truncated: false,
  };
  return { ...ok(result), wroteNothing: true };
}
