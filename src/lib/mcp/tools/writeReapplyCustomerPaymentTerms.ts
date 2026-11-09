/**
 * MCP write tool: `reapply_customer_payment_terms` — preview, then re-date open customer invoices to each CUSTOMER's own
 * terms. The AR twin of `reapply_payment_terms` (supplier bills), a separate tool so that one's contract is unchanged.
 *
 * Dry-run/live parity: the live path's refusals are per-item skips decided under the invoice's row lock inside
 * `applyReapplyCustomerTerms` (not open, date changed, terms not set, terms changed, already dated), so dry_run has no
 * extra guard to mirror. The preview already lists the same pairs the apply re-checks, and the apply reports anything
 * that moved since as a skip.
 */
import type { McpTool } from '../types';
import { applyReapplyCustomerTerms, previewReapplyCustomerTerms } from '@/modules/accounting/services/ar/reapplyTerms';
import { REAPPLY_MAX, ReapplyRefusal, parseReapplyItems } from '@/modules/accounting/services/shared/reapplyTermsShared';
import { castableArgError, ok, strArg, toolError } from './toolHelpers';
import { itemsCheckOf, reapplyItemsSchema, toPairs } from './reapplyToolShared';

export const reapplyCustomerPaymentTermsTool: McpTool = {
  name: 'reapply_customer_payment_terms',
  description:
    'Re-date OPEN customer invoices (draft, pending approval, approved, sent, overdue, part-paid) to each CUSTOMER\'s own payment terms. '
    + 'The new due date is always the customer\'s terms applied to the invoice\'s invoice date, never the company default; '
    + 'customers with no terms set are skipped and listed (skipped_customers). '
    + 'ALWAYS preview first (dry_run true; writes nothing) and show the person the rows. Then call again with '
    + 'dry_run false and send back ONLY the rows the person confirmed, each as its preview row\'s invoice_id, new_due_date '
    + '(as due_date), current_due_date and current_source. Rows with preselected=false '
    + '(the date was set by hand or came from the document) '
    + 'must NOT be sent unless the person explicitly ticked them. Each invoice is re-checked under lock when applied and '
    + 'skipped with a reason (not_found, not_open, date_changed, terms_not_set, terms_changed, already_dated) if its '
    + 'due date or its source, its terms or its status changed since the preview: a date set by hand since then is never overwritten. '
    + 'A written invoice\'s due-date source becomes "terms". balance is in the invoice\'s own currency_code. Previews list at most '
    + `${REAPPLY_MAX} invoices (truncated=true: narrow with customer_id). For supplier bills use reapply_payment_terms.`,
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'Limit the preview to one customer (UUID from list_customers).' },
      dry_run: { type: 'boolean', description: 'true previews and writes nothing; false applies `items`. Required, so a bare call never writes.' },
      items: reapplyItemsSchema(REAPPLY_MAX, 'Invoice', 'customer_id'),
      idempotency_key: { type: 'string' },
    },
    required: ['dry_run', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = castableArgError(args, { uuid: ['customer_id'] });
    if (bad) return toolError(bad);
    // Explicit on purpose: the write-tool floor (tools-write.test.ts) requires a bare call to refuse, so no default.
    if (typeof args.dry_run !== 'boolean') return toolError('dry_run is required: true to preview, false to apply the confirmed items');

    if (args.dry_run) {
      try {
        // Pairs sent with a dry run are checked as the live call checks them (parseReapplyItems refuses the same input),
        // and each one is matched against this preview, so the agent can dry-run exactly what it will send.
        const pairs = args.items === undefined ? null : parseReapplyItems(toPairs(args.items), 'invoice');
        const p = await previewReapplyCustomerTerms(ctx.companyId, { customerId: strArg(args, 'customer_id') });
        const itemsCheck = pairs ? itemsCheckOf(pairs, p.rows) : undefined;
        // A preview writes nothing: it must not occupy the idempotency key the confirmed call reuses (registry.ts).
        return { ...ok({
          dry_run: true,
          rows: p.rows.map((r) => ({
            invoice_id: r.id,
            invoice_number: r.invoiceNumber,
            customer_id: r.customerId,
            customer_name: r.customerName,
            status: r.status,
            invoice_date: r.invoiceDate,
            balance: r.balance,
            currency_code: r.currencyCode,
            current_due_date: r.currentDueDate,
            current_source: r.currentSource,
            new_due_date: r.newDueDate,
            terms: r.terms,
            preselected: r.preselected,
            note: r.note,
          })),
          unchanged: p.unchanged,
          skipped_customers: p.skippedCustomers.map((c) => ({
            customer_id: c.customerId, customer_name: c.customerName, open_invoices: c.openInvoices, balance: c.balance,
          })),
          truncated: p.truncated,
          ...(itemsCheck ? { items_check: itemsCheck } : {}),
        }), wroteNothing: true };
      } catch (err) {
        if (err instanceof ReapplyRefusal) return toolError(err.message);
        throw err;
      }
    }

    if (!Array.isArray(args.items) || args.items.length === 0) {
      return toolError('items is required when dry_run is false: send the confirmed { invoice_id, due_date, current_due_date, current_source } rows from the preview');
    }
    try {
      const r = await applyReapplyCustomerTerms(ctx.companyId, toPairs(args.items));
      return ok({
        dry_run: false,
        updated: r.updated.map((u) => ({ invoice_id: u.id, invoice_number: u.invoiceNumber, from: u.from, to: u.to })),
        skipped: r.skipped.map((s) => ({ invoice_id: s.id, reason: s.reason })),
      });
    } catch (err) {
      // A refusal (malformed items) throws before any invoice is touched, so returning it is write-free. Anything else, a
      // lock timeout at a later invoice included, is RE-THROWN: only a throw rolls the registry's savepoint back, and
      // earlier invoices of this call may already be written (a returned toolError would commit them).
      if (err instanceof ReapplyRefusal) return toolError(err.message);
      throw err;
    }
  },
};
