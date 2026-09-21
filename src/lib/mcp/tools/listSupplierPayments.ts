/**
 * MCP read tool: `list_supplier_payments`.
 *
 * Every supplier payment — any status, applied or not — with what each has
 * applied to bills and what it has not. `list_unapplied_payments` shows only
 * the unapplied remainder of processed payments, which made matching IsaFlow's
 * payments against a Sage export of all of them impossible.
 *
 * Offset-paged with `next_offset`, like list_supplier_invoices; the service
 * orders on a total order so a walk serves every payment exactly once.
 */
import type { McpTool } from '../types';
import {
  listSupplierPayments,
  type SupplierPaymentListRow,
} from '@/modules/accounting/services/ap/supplierPaymentListService';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';

const STATUSES = ['draft', 'approved', 'processed', 'reconciled', 'cancelled'] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const listSupplierPaymentsTool: McpTool = {
  name: 'list_supplier_payments',
  description:
    'Every supplier payment of the connected company, newest first — any status, applied or not — '
    + 'each with payment_amount, allocated_amount (applied to bills) and unapplied_amount. Use it to '
    + 'match payments against another system (a Sage export) or to review a supplier\'s payments. '
    + 'Filter by supplier_id, status, from_date/to_date and search (payment number, reference or '
    + 'description). totals are over the WHOLE filter, not just the page. Returns {payments, total, '
    + `totals, next_offset}: up to limit rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); call again `
    + 'with offset=next_offset until it is null. Note: only processed and reconciled payments have '
    + 'posted a journal; a draft or approved payment\'s allocations are planned, not settled. For the '
    + 'unapplied cash that explains aged_creditors vs the control account, use list_unapplied_payments.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'Supplier UUID (from list_suppliers)' },
      status: { type: 'string', enum: [...STATUSES] },
      from_date: { type: 'string', format: 'date', description: 'Payments dated on or after, YYYY-MM-DD' },
      to_date: { type: 'string', format: 'date', description: 'Payments dated on or before, YYYY-MM-DD' },
      search: { type: 'string', description: 'Matches payment number, reference or description' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['supplier_id'], date: ['from_date', 'to_date'] });
    if (bad) return bad;
    // The schema enum is documentation only; the transport validates nothing.
    const status = strArg(args, 'status');
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      return toolError(`status must be one of: ${STATUSES.join(', ')}`);
    }
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const fromDate = strArg(args, 'from_date');
    const toDate = strArg(args, 'to_date');
    if (fromDate && toDate && fromDate > toDate) return toolError('from_date must not be after to_date');

    const result = await listSupplierPayments(ctx.companyId, {
      supplierId: strArg(args, 'supplier_id') ?? null,
      status: status ?? null,
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
      search: strArg(args, 'search') ?? null,
      limit: clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT),
      offset,
    });
    return ok({
      payments: result.rows.map(rowReply),
      total: result.total,
      totals: {
        payment_amount: result.totals.paymentAmount,
        allocated_amount: result.totals.allocatedAmount,
        unapplied_amount: result.totals.unappliedAmount,
      },
      next_offset: nextOffsetFromTotal(offset, result.rows.length, result.total),
    });
  },
};

function rowReply(r: SupplierPaymentListRow) {
  return {
    payment_id: r.paymentId,
    payment_number: r.paymentNumber,
    payment_date: r.paymentDate,
    supplier_id: r.supplierId,
    supplier_name: r.supplierName,
    payment_amount: r.paymentAmount,
    allocated_amount: r.allocatedAmount,
    unapplied_amount: r.unappliedAmount,
    status: r.status,
    payment_method: r.paymentMethod,
    reference: r.reference,
    description: r.description,
    journal_entry_id: r.journalEntryId,
    batch_id: r.batchId,
  };
}
