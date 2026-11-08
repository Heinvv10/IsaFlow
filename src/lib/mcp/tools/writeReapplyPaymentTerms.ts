/**
 * MCP write tool: `reapply_payment_terms` — preview, then re-date open supplier bills to each SUPPLIER's own terms.
 *
 * Dry-run/live parity: the live path's refusals are per-item skips decided under the bill's row lock inside
 * `applyReapplyTerms` (not open, date changed, terms not set, terms changed, already dated), so dry_run has no extra guard to mirror.
 * The preview already lists the same pairs the apply re-checks, and the apply reports anything that moved since as a skip.
 */
import type { McpTool } from '../types';
import {
  REAPPLY_MAX,
  ReapplyRefusal,
  applyReapplyTerms,
  parseReapplyItems,
  previewReapplyTerms,
} from '@/modules/accounting/services/ap/reapplyTerms';
import { castableArgError, ok, strArg, toolError } from './toolHelpers';
import { itemsCheckOf, reapplyItemsSchema, toPairs } from './reapplyToolShared';

export const reapplyPaymentTermsTool: McpTool = {
  name: 'reapply_payment_terms',
  description:
    'Re-date OPEN supplier bills (draft, pending approval, approved, part-paid) to each SUPPLIER\'s own payment terms. '
    + 'The new due date is always the supplier\'s terms applied to the bill\'s invoice date, never the company default; '
    + 'suppliers with no terms set are skipped and listed (skipped_suppliers). '
    + 'ALWAYS preview first (dry_run true; writes nothing) and show the person the rows. Then call again with '
    + 'dry_run false and send back ONLY the rows the person confirmed, each as its preview row\'s invoice_id, new_due_date '
    + '(as due_date), current_due_date and current_source. Rows with preselected=false '
    + '(the date was set by hand or came from the document) '
    + 'must NOT be sent unless the person explicitly ticked them. Each bill is re-checked under lock when applied and '
    + 'skipped with a reason (not_found, not_open, date_changed, terms_not_set, terms_changed, already_dated) if its '
    + 'due date or its source, its terms or its status changed since the preview: a date set by hand since then is never overwritten. A written bill\'s due-date source becomes "terms". Previews list at most '
    + `${REAPPLY_MAX} bills (truncated=true: narrow with supplier_id).`,
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'Limit the preview to one supplier (UUID from list_suppliers).' },
      dry_run: { type: 'boolean', description: 'true previews and writes nothing; false applies `items`. Required, so a bare call never writes.' },
      items: reapplyItemsSchema(REAPPLY_MAX, 'Bill', 'supplier_id'),
      idempotency_key: { type: 'string' },
    },
    required: ['dry_run', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = castableArgError(args, { uuid: ['supplier_id'] });
    if (bad) return toolError(bad);
    // Explicit on purpose: the write-tool floor (tools-write.test.ts) requires a bare call to refuse, so no default.
    if (typeof args.dry_run !== 'boolean') return toolError('dry_run is required: true to preview, false to apply the confirmed items');
    const dryRun = args.dry_run;

    if (dryRun) {
      try {
        // Pairs sent with a dry run are checked as the live call checks them (parseReapplyItems refuses the same input),
        // and each one is matched against this preview, so the agent can dry-run exactly what it will send.
        const pairs = args.items === undefined ? null : parseReapplyItems(toPairs(args.items));
        const p = await previewReapplyTerms(ctx.companyId, { supplierId: strArg(args, 'supplier_id') });
        const itemsCheck = pairs ? itemsCheckOf(pairs, p.rows) : undefined;
        // A preview writes nothing: it must not occupy the idempotency key the confirmed call reuses (registry.ts).
        return { ...ok({
          dry_run: true,
          rows: p.rows.map((r) => ({
            invoice_id: r.id,
            invoice_number: r.invoiceNumber,
            supplier_id: r.supplierId,
            supplier_name: r.supplierName,
            status: r.status,
            invoice_date: r.invoiceDate,
            balance: r.balance,
            current_due_date: r.currentDueDate,
            current_source: r.currentSource,
            new_due_date: r.newDueDate,
            terms: r.terms,
            preselected: r.preselected,
            note: r.note,
          })),
          unchanged: p.unchanged,
          skipped_suppliers: p.skippedSuppliers.map((s) => ({
            supplier_id: s.supplierId, supplier_name: s.supplierName, open_bills: s.openBills, balance: s.balance,
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
    const items = toPairs(args.items);
    try {
      const r = await applyReapplyTerms(ctx.companyId, items);
      return ok({
        dry_run: false,
        updated: r.updated.map((u) => ({ invoice_id: u.id, invoice_number: u.invoiceNumber, from: u.from, to: u.to })),
        skipped: r.skipped.map((s) => ({ invoice_id: s.id, reason: s.reason })),
      });
    } catch (err) {
      // A refusal (malformed items) throws before any bill is touched, so returning it is write-free. Anything else, a
      // lock timeout at a later bill included, is RE-THROWN: only a throw rolls the registry's savepoint back, and
      // earlier bills of this call may already be written (a returned toolError would commit them).
      if (err instanceof ReapplyRefusal) return toolError(err.message);
      throw err;
    }
  },
};
