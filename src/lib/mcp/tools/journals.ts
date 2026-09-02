/**
 * MCP read tool: list_journals — every GL journal in a window, across all
 * accounts, with keyset paging. search_gl answers "what hit THIS account";
 * this answers "what was posted at all", which is what a period review or a
 * duplicate hunt needs.
 */
import type { McpTool } from '../types';
import {
  JOURNAL_LIST_STATUSES,
  listJournalEntriesPage,
  type JournalListStatus,
} from '@/modules/accounting/services/gl/journalEntryListService';
import { InvalidCursorError } from '@/modules/accounting/services/bank/bankTxCursor';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const listJournalsTool: McpTool = {
  name: 'list_journals',
  description:
    'GL journal entries for this company in an entry-date window, across ALL accounts and sources (bank allocations, invoices, manual, auto-post), newest first. ' +
    'Unlike list_agent_postings it is not limited to MCP-created entries. ' +
    'status: draft = not yet posted; posted = in the ledger; reversed = posted entries that a contra has already been posted against. status=posted INCLUDES reversed entries (status never flips on reversal — reversed: true on the row is the only signal), so filter them out client-side or ask for status=reversed to see just those. ' +
    'account_id restricts to journals with at least one line on that account. ' +
    'include_lines=true adds each journal\'s lines (account code/name, debit, credit) — leave it off when scanning. ' +
    'limit is capped at 100 (default 50). Paging: the reply carries next_cursor whenever more rows match; call again with cursor set and every other argument unchanged until next_cursor is null.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD (entry date, inclusive)' },
      to_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD (entry date, inclusive)' },
      status: { type: 'string', enum: [...JOURNAL_LIST_STATUSES] },
      source: { type: 'string', description: 'Exact source value, e.g. "manual", "bank", "customer_invoice".' },
      account_id: { type: 'string', description: 'gl_accounts.id — only journals touching this account.' },
      include_lines: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const rawStatus = strArg(args, 'status');
    // inputSchema.enum is advisory (the transport does not validate); an
    // unknown status is refused rather than filtered to an empty list, which
    // an agent would read as "nothing was posted".
    if (rawStatus !== undefined && !(JOURNAL_LIST_STATUSES as readonly string[]).includes(rawStatus)) {
      return toolError(`invalid status — expected one of: ${JOURNAL_LIST_STATUSES.join(', ')}`);
    }
    // account_id lands as $n::UUID and the dates as $n::DATE.
    const bad = guardCastableArgs(args, { uuid: ['account_id'], date: ['from_date', 'to_date'] });
    if (bad) return bad;
    try {
      // Tenant from ctx ONLY. account_id narrows a query fenced to the company:
      // a foreign id matches nothing, so it needs no ownership check.
      const page = await listJournalEntriesPage(ctx.companyId, {
        fromDate: strArg(args, 'from_date'),
        toDate: strArg(args, 'to_date'),
        status: rawStatus as JournalListStatus | undefined,
        source: strArg(args, 'source'),
        accountId: strArg(args, 'account_id'),
        includeLines: args.include_lines === true,
        limit: clampLimit(args, 50, 100),
        cursor: strArg(args, 'cursor'),
      });
      return ok({ journals: page.entries, next_cursor: page.nextCursor });
    } catch (err) {
      if (err instanceof InvalidCursorError) return toolError('invalid cursor');
      throw err;
    }
  },
};
