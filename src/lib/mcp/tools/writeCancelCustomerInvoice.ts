/**
 * MCP write tool: `cancel_customer_invoice` — DRAFTS ONLY (Hein, 2026-11-13).
 *
 * A draft or pending-approval customer invoice has no journal, so cancelling it is a status flip with no ledger
 * effect. Cancelling an APPROVED invoice reverses its journal; the connector has no planner for that reversal
 * (bank matches, locked VAT periods, closed periods — see cancel_supplier_invoice), so it stays in the app and is
 * refused here.
 *
 * Every refusal is answered from READS on the LOCKED row, before the cancel runs, and the cancel is called with NO
 * catch (contracts/mutation.ts rule 2). The lock is what makes the refusals hold: `cancelCustomerInvoice` re-locks the
 * same row (a no-op inside this request transaction), so no approval or payment can land between the checks and the
 * write and turn this into a journal reversal.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '@/lib/mcp/contracts';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { RowLockTimeoutError, withRowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'cancel_customer_invoice';
const CANCELLABLE = ['draft', 'pending_approval'];
/** Amounts below this are rounding, as in customerInvoiceCancelService. */
const ZERO_TOLERANCE = 0.005;

export const cancelCustomerInvoiceTool: McpTool = {
  name: TOOL,
  description:
    'Cancel a DRAFT or pending-approval customer invoice (e.g. a duplicate). It has no journal, so nothing posts and '
    + 'no balance moves; the invoice becomes cancelled and drops out of every list of open work. Refused, with the '
    + 'reason, when the invoice is approved or later (cancel it in the app, which reverses its journal), already '
    + 'cancelled, carries a journal, or has a payment applied or allocated to it. Cancelling is final: there is no '
    + 'un-cancel. Run with dry_run first: it runs the same checks and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', description: 'The customer invoice, from list_invoices.' },
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

    // Locked for the rest of the request transaction (see the header), with a bounded wait: a peer holding the row
    // past the budget THROWS RowLockTimeoutError ("retry in a moment"), before any write. A soft-deleted invoice reads
    // as not found, as the service treats it.
    const [inv] = await withRowLockBudget(async () => (await sql`
      SELECT id, invoice_number, status, amount_paid, total_amount, gl_journal_entry_id
      FROM customer_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${ctx.companyId}::UUID AND deleted_at IS NULL
      FOR UPDATE
    `) as DbRow[], () => new RowLockTimeoutError(`Invoice ${invoiceId}`));
    if (!inv) return toolError(NOT_FOUND);
    const number = String(inv.invoice_number);
    const status = String(inv.status);

    if (status === 'cancelled') return toolError(`${number} is already cancelled.`);
    if (!CANCELLABLE.includes(status)) {
      return toolError(`${number} is ${status}: this tool cancels draft and pending-approval invoices only. `
        + 'Cancel it in the app, which reverses its journal.');
    }
    if (inv.gl_journal_entry_id) {
      return toolError(`${number} is ${status} but carries a journal, which cancelling would reverse. `
        + 'Cancel it in the app.');
    }
    const [alloc] = (await sql`
      SELECT COALESCE(SUM(cpa.amount_allocated), 0) AS allocated
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id
      WHERE cpa.invoice_id = ${invoiceId}::UUID AND cp.company_id = ${ctx.companyId}::UUID AND cp.status <> 'cancelled'
    `) as DbRow[];
    if (Number(inv.amount_paid ?? 0) > ZERO_TOLERANCE || Number(alloc?.allocated ?? 0) > ZERO_TOLERANCE) {
      return toolError(`${number} has a payment applied or allocated to it; remove that first (void_receipt).`);
    }

    if (args.dry_run === true) {
      const preview: DryRunResult = {
        dryRun: true, journals: [], skipped: [], effects: [], journalsTotal: 0, truncated: false,
      };
      // `wroteNothing` keeps the idempotency key free for the real call.
      return {
        ...ok({ ...preview, invoice_id: invoiceId, invoice_number: number, status_before: status, status_after: 'cancelled' }),
        wroteNothing: true,
      };
    }

    // No catch: only pre-write validation may return toolError (contracts/mutation.ts rule 2).
    await cancelCustomerInvoice(ctx.companyId, invoiceId, ctx.userId);
    return ok({ invoice_id: invoiceId, invoice_number: number, status_before: status, status: 'cancelled' });
  },
};
