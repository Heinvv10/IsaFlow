/**
 * MCP read tools for customer receipts: `suggest_receipt_matches` and
 * `list_unapplied_receipts`.
 *
 * `suggest_receipt_matches` PROPOSES AND NEVER POSTS, exactly like
 * `suggest_bank_allocation`. That pattern works and is copied rather than
 * improved on: the agent gets a scored shortlist and has to make the decision
 * itself through `apply_receipt_to_invoice`.
 *
 * `list_unapplied_receipts` is the other half — cash that is in the ledger and
 * attached to no invoice. It is what an agent runs to find work for
 * `apply_receipt_to_invoice`, and what a reviewer runs to see whether the AR
 * control account can possibly agree with the aged debtors report.
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
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';
import {
  getUnappliedReceipts,
  type UnappliedReceiptRow,
} from '@/modules/accounting/services/ar/unappliedReceiptService';
import { getUnappliedReceiptOrigins } from '@/modules/accounting/services/ar/unappliedReceiptOrigin';
import { fmtDate } from '@/lib/fmtDate';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const suggestReceiptMatchesTool: McpTool = {
  name: 'suggest_receipt_matches',
  description:
    'Scored shortlist of the customer invoices one incoming bank receipt is most likely to '
    + 'settle. READ-ONLY: it proposes and never posts — apply the result with '
    + 'apply_receipt_to_invoice. Scored on the invoice number appearing in the bank narration '
    + '(exact or fuzzy), how close the amount is to the outstanding balance, how close the dates '
    + 'are, name overlap, and whether the customer opened the invoice in the portal recently. '
    + 'Roughly 100 out of a theoretical 170 is auto-match confidence. Returns AT MOST 5 '
    + 'candidates: rowsTotal is how many invoices were scored and universeTotal how many were '
    + 'considered, so five out of five and five out of fifty can be told apart. '
    + 'Returns nothing at all for a transaction that is money OUT or that does not exist — a '
    + 'receipt is money in. Does NOT cover supplier invoices, purchase orders or journal lines: '
    + 'use get_match_candidates for a bank line that could be any of those. Never paginates: '
    + 'widening a shortlist past five defeats the point of ranking it.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      bank_transaction_id: {
        type: 'string',
        description: 'The receipt to match, from list_bank_transactions.',
      },
    },
    required: ['bank_transaction_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = strArg(args, 'bank_transaction_id');
    if (!txId) return toolError('bank_transaction_id is required');
    const bad = guardCastableArgs(args, { uuid: ['bank_transaction_id'] });
    if (bad) return bad;

    // companyId from ctx ONLY.
    const result = await getReceiptMatchCandidates(txId, ctx.companyId);

    // Every invoice in the pool was scored, so nothing falls between the two
    // counts and there is nothing to exclude. `truncated` carries the real
    // fact: five candidates out of however many were scored.
    return ok({
      ...buildEnvelope({
        rows: result.candidates,
        rowsTotal: result.scoredTotal,
        universeTotal: result.poolConsidered,
        detail: 'standard' as DetailLevel,
        as_at: fmtDate(new Date()),
        // A suggestion is not a figure anybody re-derives, and the scoring reads
        // no posted ledger rows — only open invoices and portal views. There is
        // no ledger write for a posted_through to name.
        posted_through: new Date(0).toISOString(),
        next_cursor: null,
      }),
      bank_transaction_id: txId,
    });
  },
};

export const listUnappliedReceiptsTool: McpTool = {
  name: 'list_unapplied_receipts',
  description:
    'Customer receipts that are in the ledger but attached to no invoice — cash sitting on the '
    + 'Accounts Receivable control account that no document knows about. This is the population '
    + 'apply_receipt_to_invoice exists to clear, and the reason aged_debtors can disagree with '
    + 'the control account. A receipt appears here when its amount exceeds the sum of its '
    + 'allocations, so PARTLY applied receipts appear for their remainder. Cancelled receipts '
    + 'are excluded. totalUnapplied is the sum over every matching receipt, not just this page. '
    + 'Does NOT cover cash credited to the control account by a plain journal with no customer '
    + 'payment record behind it — that is invisible here by construction and is what '
    + 'reconcile_subledger is for. Receipts whose customer row is missing or deleted are '
    + 'reported in excludedRows with their amount, never silently dropped. Paginate with '
    + 'next_cursor; rows come oldest first. '
    + 'IMPORTANT — THIS BALANCE IS STILL GROWING. Allocating a bank line to a customer posts the '
    + 'DR Bank / CR Accounts Receivable journal and creates the receipt, but applies it to no '
    + 'invoice, so every allocation adds to this total and a bulk run adds hundreds. `origins` '
    + 'splits the total by who created it: an mcp: posting stamp PROVES an agent made it, and '
    + 'agentTools names which tool. Everything else with a journal is reported as "not stamped as '
    + 'an agent" rather than as human, because a human stamp proves nothing — createJournalEntry '
    + 'applies it whenever a caller omits the posting meta. Receipts with no journal at all are '
    + 'counted separately again.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: {
        type: 'string',
        format: 'date',
        description: 'Receipts dated on or before this day, YYYY-MM-DD. Defaults to today.',
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
    // `full` is not offered: a receipt's underlying transactions ARE its
    // allocations, and an unapplied one has none. Offering the level and
    // returning the same rows would be a lie about what it does.
    if (requested === 'full') {
      return toolError('detail "full" is not available here — an unapplied receipt has no allocations to expand.');
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
    // Two reads, both company-scoped from ctx. The origin split is cheap (one
    // grouped scan of the same population) and is the question that follows
    // immediately from the total: the bucket is filling, and a reader given
    // only the total goes looking for a historical cause that is not there.
    const [result, origins] = await Promise.all([
      getUnappliedReceipts(ctx.companyId, { asAt, limit, after }),
      getUnappliedReceiptOrigins(ctx.companyId, asAt),
    ]);

    const rows = detail === 'summary' ? [] : result.rows.map(rowReply);
    const last = detail === 'summary' ? undefined : result.rows[result.rows.length - 1];
    const nextCursor = last && result.rows.length === limit
      ? encodeCursor({ parts: [last.paymentDate, last.paymentId] })
      : null;

    const excludedRows: ExcludedRow[] = result.unattributed.map((r) => ({
      id: r.paymentId,
      reason: 'unknown_counterparty',
      detail: 'The customer this receipt names no longer exists or has been deleted.',
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
      origins: {
        agent: origins.agent,
        system: origins.system,
        not_stamped_as_agent: origins.notStampedAsAgent,
        no_journal: origins.noJournal,
        total: origins.total,
        agent_tools: origins.agentTools.map((t) => ({
          posting_agent: t.postingAgent,
          receipts: t.receipts,
          unapplied: t.unapplied,
        })),
        caveat: origins.caveat,
      },
    });
  },
};

function rowReply(r: UnappliedReceiptRow) {
  return {
    payment_id: r.paymentId,
    payment_number: r.paymentNumber,
    payment_date: r.paymentDate,
    customer_id: r.customerId,
    customer_name: r.customerName,
    receipt_amount: r.receiptAmount,
    allocated_amount: r.allocatedAmount,
    unapplied_amount: r.unappliedAmount,
    status: r.status,
    reference: r.reference,
    description: r.description,
    journal_entry_id: r.journalEntryId,
  };
}
