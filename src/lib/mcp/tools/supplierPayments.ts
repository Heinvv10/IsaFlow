/**
 * MCP read tools for supplier payments: `list_unapplied_payments`.
 *
 * The AP mirror of `list_unapplied_receipts` in `receipts.ts` — cash that has
 * left the bank, been debited to the Accounts Payable control account, and
 * attached to no bill. It is what an agent runs to find work for
 * `apply_supplier_payment`, and what a reviewer runs to see whether the AP
 * control account can possibly agree with the aged creditors report.
 *
 * It lives in its own file rather than beside its AR twin so that neither
 * crosses the 300-line rule.
 */
import type { McpTool } from '../types';
import {
  buildEnvelope,
  decodeCursor,
  encodeCursor,
  isDetailLevel,
  type DetailLevel,
  type ExcludedRow,
} from '@/lib/mcp/contracts';
import {
  getUnappliedPayments,
  type UnappliedPaymentRow,
} from '@/modules/accounting/services/ap/unappliedPaymentService';
import { fmtDate } from '@/lib/fmtDate';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const listUnappliedPaymentsTool: McpTool = {
  name: 'list_unapplied_payments',
  description:
    'Supplier payments that are in the ledger but attached to no bill — cash debited to the '
    + 'Accounts Payable control account that no document knows about. Allocating a bank line to a '
    + 'supplier posts the DR Accounts Payable / CR Bank journal and creates the payment, but '
    + 'applies it to no bill, which is what produces these rows. This is the population '
    + 'apply_supplier_payment exists to clear, and the reason aged_creditors can disagree with the '
    + 'control account. A payment appears here when its amount exceeds the sum of its allocations, '
    + 'so PARTLY applied payments appear for their remainder. Cancelled payments are excluded, and '
    + 'so are draft and approved ones: those have no journal behind them, no cash has left the '
    + 'bank and nothing has reached the control account, so listing them would invent a '
    + 'reconciling item. Only processed and reconciled payments are counted. totalUnapplied is the '
    + 'sum over every matching payment, not just this page. Does NOT cover cash debited to the '
    + 'control account by a plain journal with no supplier payment record behind it — that is '
    + 'invisible here by construction and is what reconcile_subledger is for. Payments whose '
    + 'supplier row is missing or deleted are reported in excludedRows with their amount, never '
    + 'silently dropped. Paginate with next_cursor; rows come oldest first.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: {
        type: 'string',
        format: 'date',
        description: 'Payments dated on or before this day, YYYY-MM-DD. Defaults to today.',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'standard'],
        description:
          '"summary" returns the totals and completeness only, with no rows — use it to see how '
          + 'much unapplied cash there is before deciding to page through it. Default "standard".',
      },
      limit: { type: 'number', description: `Rows per page, max ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;
    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());

    const requested = strArg(args, 'detail');
    if (requested !== undefined && !isDetailLevel(requested)) {
      return toolError('detail must be "summary" or "standard"');
    }
    // `full` is not offered: a payment's underlying transactions ARE its
    // allocations, and an unapplied one has none. Offering the level and
    // returning the same rows would be a lie about what it does.
    if (requested === 'full') {
      return toolError('detail "full" is not available here — an unapplied payment has no allocations to expand.');
    }
    const detail: DetailLevel = requested ?? 'standard';

    const rawCursor = strArg(args, 'cursor');
    let after: { paymentDate: string; id: string } | null = null;
    if (rawCursor) {
      const decoded = decodeCursor(rawCursor, 2);
      if (!decoded) return toolError('invalid cursor');
      after = { paymentDate: decoded.parts[0]!, id: decoded.parts[1]! };
    }

    const limit = detail === 'summary' ? 1 : clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT);
    // companyId from ctx ONLY.
    const result = await getUnappliedPayments(ctx.companyId, { asAt, limit, after });

    const rows = detail === 'summary' ? [] : result.rows.map(rowReply);
    const last = detail === 'summary' ? undefined : result.rows[result.rows.length - 1];
    const nextCursor = last && result.rows.length === limit
      ? encodeCursor({ parts: [last.paymentDate, last.paymentId] })
      : null;

    const excludedRows: ExcludedRow[] = result.unattributed.map((r) => ({
      id: r.paymentId,
      reason: 'unknown_counterparty',
      detail: 'The supplier this payment names no longer exists or has been deleted.',
      amount: r.unappliedAmount,
      documentNumber: r.paymentNumber,
    }));

    return ok({
      ...buildEnvelope({
        rows,
        rowsTotal: result.rowsTotal,
        universeTotal: result.universeTotal,
        excludedRows,
        detail,
        as_at: asAt,
        posted_through: result.postedThrough,
        next_cursor: nextCursor,
      }),
      totalUnapplied: result.totalUnapplied,
      totalUnattributed: result.totalUnattributed,
      historyCoverage: result.historyCoverage,
    });
  },
};

function rowReply(r: UnappliedPaymentRow) {
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
    reference: r.reference,
    description: r.description,
    journal_entry_id: r.journalEntryId,
  };
}
