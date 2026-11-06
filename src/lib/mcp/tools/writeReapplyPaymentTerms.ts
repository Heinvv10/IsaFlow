/**
 * MCP write tool: `reapply_payment_terms` — preview, then re-date open supplier bills to each SUPPLIER's own terms.
 *
 * Dry-run/live parity: the live path's refusals are per-item skips decided under the bill's row lock inside
 * `applyReapplyTerms` (not open, terms not set, terms changed, already dated), so dry_run has no extra guard to mirror.
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

/** The tool's snake_case pairs as the service's { id, dueDate } (validated by parseReapplyItems). */
function toPairs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    return { id: o.invoice_id, dueDate: o.due_date };
  });
}

export const reapplyPaymentTermsTool: McpTool = {
  name: 'reapply_payment_terms',
  description:
    'Re-date OPEN supplier bills (draft, pending approval, approved, part-paid) to each SUPPLIER\'s own payment terms. '
    + 'The new due date is always the supplier\'s terms applied to the bill\'s invoice date, never the company default; '
    + 'suppliers with no terms set are skipped and listed (skipped_suppliers). '
    + 'ALWAYS preview first (dry_run true; writes nothing) and show the person the rows. Then call again with '
    + 'dry_run false and send back ONLY the (invoice_id, due_date) pairs the person confirmed. Rows with preselected=false '
    + '(the date was set by hand or came from the document, or the supplier is on the old stamped default of 30 days) '
    + 'must NOT be sent unless the person explicitly ticked them. Each bill is re-checked under lock when applied and '
    + 'skipped with a reason (not_found, not_open, terms_not_set, terms_changed, already_dated) if its terms or status '
    + 'changed since the preview. A written bill\'s due-date source becomes "terms". Previews list at most '
    + `${REAPPLY_MAX} bills (truncated=true: narrow with supplier_id).`,
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'Limit the preview to one supplier (UUID from list_suppliers).' },
      dry_run: { type: 'boolean', description: 'true previews and writes nothing; false applies `items`. Required, so a bare call never writes.' },
      items: {
        type: 'array',
        maxItems: REAPPLY_MAX,
        description: 'Required when dry_run is false: the confirmed pairs, taken from the preview. With dry_run true they are checked as the live call checks them and items_check says what each would do.',
        items: {
          type: 'object',
          properties: {
            invoice_id: { type: 'string', description: 'Bill UUID from the preview row.' },
            due_date: { type: 'string', format: 'date', description: 'The preview row\'s new_due_date, YYYY-MM-DD.' },
          },
          required: ['invoice_id', 'due_date'],
          additionalProperties: false,
        },
      },
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
        const listed = new Map(p.rows.map((r) => [r.id, r.newDueDate]));
        const itemsCheck = pairs?.map(({ id, dueDate }) => ({
          invoice_id: id,
          would: !listed.has(id) ? 'not_listed' : listed.get(id) === dueDate ? 'update' : 'terms_changed',
        }));
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
      return toolError('items is required when dry_run is false: send the confirmed { invoice_id, due_date } pairs from the preview');
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
