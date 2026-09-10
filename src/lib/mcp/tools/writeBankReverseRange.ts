/**
 * MCP write tool: reverse every allocation in one bank account over a date
 * range, atomically.
 *
 * `reverse_bank_allocation_batch` navigates by a `batch_id`, which only exists
 * for allocations made by `bulk_allocate_bank_transactions`. Allocations
 * created by a bank RULE or by an import carry no batch, so they could only be
 * reversed one at a time. Nine rule-created allocations had to be unwound
 * individually during the Velocity Fibre migration, and three of the nine were
 * blocked by an approval layer part-way through — leaving the ledger
 * consistent but the job half-done, with nothing on the outside saying which
 * half.
 *
 * ALL-OR-NOTHING is therefore the whole point, not a nicety. `registry.call()`
 * wraps the handler in ONE savepoint that unwinds only on a THROW, so the
 * reversal loop has no try/catch: if the eighth reversal fails, the first seven
 * go back too. A half-reversed range is the state this tool exists to prevent,
 * so it must never be able to produce one.
 *
 * The range is the dangerous part of the design, so two guards sit in front of
 * it. `dry_run` reports what WOULD be reversed (or refuses, when an approval is
 * required for one of them), and an oversize range
 * is REFUSED rather than truncated — reversing the first N of M and saying
 * nothing would be the same half-done state, only harder to notice.
 */
import type { McpTool } from '../types';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  findAllocatedInRange,
  countAllocatedInRange,
} from '@/modules/accounting/services/bank/bankAllocationRangeService';
import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { REVERSAL_DATE_PROPERTY } from './allocationSchema';
import { mcpPostingOpts } from '../mcpActor';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const REVERSE_RANGE_TOOL = 'reverse_allocations';

/**
 * Above this the call refuses. It is a blast-radius limit, not a page size:
 * every row in the range is reversed inside ONE transaction, so the cap also
 * bounds how long the account's rows stay locked.
 */
const MAX_RANGE = 500;

export const reverseAllocationsTool: McpTool = {
  name: REVERSE_RANGE_TOOL,
  description:
    'Reverse EVERY allocation in one bank account between two dates, inclusive — including allocations made by bank rules or by an import, which carry no batch_id and cannot be reversed by reverse_bank_allocation_batch. ' +
    'ALL OR NOTHING: if any reversal fails, none are applied, so the account is never left half-unwound. ' +
    `Refuses (it does not truncate) if the range holds more than ${MAX_RANGE} allocated transactions — narrow the dates. ` +
    'Run with dry_run=true first: it reports exactly which transactions would be reversed, with the rule that created each one, and writes nothing — ' + 'unless the company policy requires an independent approval for one of them, in which case the dry run refuses exactly as the live call does. ' +
    'Unallocated, excluded and already-reversed transactions in the range are not touched. Requires the write:post permission.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: {
        type: 'string',
        description: 'The bank GL account UUID (from bank_accounts_status or list_gl_accounts).',
      },
      from_date: { type: 'string', format: 'date', description: 'Inclusive, YYYY-MM-DD' },
      to_date: { type: 'string', format: 'date', description: 'Inclusive, YYYY-MM-DD' },
      dry_run: {
        type: 'boolean',
        description: 'true reports what would be reversed and writes nothing. Do this first.',
      },
      ...REVERSAL_DATE_PROPERTY,
      idempotency_key: { type: 'string' },
    },
    required: ['bank_account_id', 'from_date', 'to_date', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const fromDate = strArg(args, 'from_date');
    const toDate = strArg(args, 'to_date');
    if (!bankAccountId) return toolError('bank_account_id is required');
    if (!fromDate) return toolError('from_date is required (YYYY-MM-DD)');
    if (!toDate) return toolError('to_date is required (YYYY-MM-DD)');

    // Every one of these lands in a cast: the id as $n::UUID and both dates as
    // $n::DATE. Guarded here so a typo names the argument instead of surfacing
    // as the registry's generic failure.
    const bad = guardCastableArgs(args, {
      uuid: ['bank_account_id'],
      date: ['from_date', 'to_date'],
    });
    if (bad) return bad;

    if (fromDate > toDate) {
      // Lexical compare is exact for YYYY-MM-DD, and both are already validated
      // as real calendar days. An inverted range silently matches nothing,
      // which would report "0 reversed" and read as "already clean".
      return toolError(`from_date (${fromDate}) is after to_date (${toDate})`);
    }

    // Ownership before anything else. `bank_account_id` becomes a foreign key
    // in the range query; the service does not re-check the tenant.
    if (!(await bankGlAccountBelongsToCompany(ctx.companyId, bankAccountId))) {
      return toolError(NOT_FOUND);
    }

    const reversalDate = strArg(args, 'reversal_date');
    const dryRun = args.dry_run === true;

    // Counted BEFORE fetching, so an oversize range is refused on the true
    // total rather than on a capped page that looks complete.
    const total = await countAllocatedInRange(ctx.companyId, bankAccountId, fromDate, toDate);
    if (total > MAX_RANGE) {
      return toolError(
        `${total} allocated transactions in ${fromDate}..${toDate} exceeds the ${MAX_RANGE} limit. ` +
          'Narrow the date range and reverse in parts.',
      );
    }
    if (total === 0) {
      // Success, not a refusal: a retry, or a second agent arriving after the
      // first finished, is harmless and should read as harmless.
      return ok({
        bank_account_id: bankAccountId, from_date: fromDate, to_date: toDate,
        dry_run: dryRun, reversed: 0, transactions: [],
      });
    }

    const rows = await findAllocatedInRange(
      ctx.companyId, bankAccountId, fromDate, toDate, MAX_RANGE,
    );

    // The preview carries the RULE behind each allocation, because the reason
    // an agent reverses a range is usually that a rule was wrong — and the rule
    // is what it has to fix next, or the next import re-creates all of this.
    const preview = rows.map((r) => ({
      transaction_id: r.id,
      date: r.transactionDate,
      amount: r.amount,
      description: r.description,
      reference: r.reference,
      journal_entry_id: r.journalEntryId,
      allocation_batch_id: r.allocationBatchId,
      created_by_rule: r.allocationRuleName,
    }));

    if (dryRun) {
      // The live reversals run through the control kernel, which refuses one
      // the company's payment policy binds — and refuses the whole call, as
      // this preview now does.
      const { bankAllocationApprovalRequired, BANK_REVERSAL_APPROVAL_TEXT } = await import('./bankPreviewApproval');
      for (const row of rows) {
        if (await bankAllocationApprovalRequired(row.amount, 'bank_allocation.reverse')) return toolError(BANK_REVERSAL_APPROVAL_TEXT);
      }
      return ok({
        bank_account_id: bankAccountId, from_date: fromDate, to_date: toDate,
        dry_run: true,
        would_reverse: rows.length,
        transactions: preview,
        // Named so an agent can go straight to fixing the cause.
        rules_involved: [...new Set(rows.map((r) => r.allocationRuleName).filter(Boolean))],
      });
    }

    // No try/catch, deliberately — see the file header. Rows arrive ordered by
    // id, the same deterministic lock order the allocate and batch-reverse
    // paths use, so this cannot deadlock against a concurrent batch.
    for (const row of rows) {
      // The contra journal is stamped too: without it the agent's own
      // correction posts as human:<userId> and drops out of list_agent_postings,
      // which is the surface a human reviews agent work through.
      await reverseReconciledTransaction(ctx.companyId, row.id, ctx.userId, {
        ...mcpPostingOpts(ctx, REVERSE_RANGE_TOOL),
        ...(reversalDate === undefined ? {} : { reversalDate }),
      });
    }

    return ok({
      bank_account_id: bankAccountId, from_date: fromDate, to_date: toDate,
      dry_run: false,
      reversed: rows.length,
      transactions: preview,
      rules_involved: [...new Set(rows.map((r) => r.allocationRuleName).filter(Boolean))],
    });
  },
};
