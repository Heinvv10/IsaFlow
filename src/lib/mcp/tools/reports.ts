/**
 * MCP read tools: financial reports. Every handler calls the SAME service
 * function its REST route uses — tools never write SQL. companyId comes
 * from ctx ONLY (never from args).
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getChartOfAccounts } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { GL_ACCOUNT_TYPES } from '@/modules/accounting/types/gl.types';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import {
  compareGlAccountKeys,
  decodeGlAccountCursor,
  encodeGlAccountCursor,
  startIndexAfter,
} from './glAccountCursor';

/**
 * `trial_balance` moved to `reportsTrialBalance.ts` when it became a WRAP of
 * `getTrialBalanceReport`. The version that lived here called `getTrialBalance`
 * with a single fiscal_period_id and returned bare rows — a period-MOVEMENT
 * listing wearing a trial balance's name, which is how 7 of 118 accounts came
 * to be stamped "Difference R0.00 · Balanced". It is not re-exported: nothing
 * should be able to reach it by accident.
 */

/**
 * `profit_and_loss` moved to `reportsProfitAndLoss.ts` when it grew the layer
 * and the coverage exception. The version that lived here returned
 * `getIncomeStatement` verbatim. Since the B75 convergence that service bands
 * through the same `expenseBand`/`revenueBand` as `aggregateFigures`, so the
 * two no longer disagree about gross profit; what this older path still lacks
 * is the coverage disclosure and the comparative. It is not re-exported.
 */

/**
 * `balance_sheet` moved to `reportsBalanceSheet.ts` when it grew the second
 * equity figure. The version that lived here passed only `as_at` — the
 * service's `compareDate` and `costCentreId` were unreachable, and it reported
 * `totalEquity` alone, which is the figure that always agrees. It is not
 * re-exported: nothing should be able to reach a one-equity balance sheet by
 * accident.
 */

/**
 * `aged_debtors` and `aged_creditors` moved to `reportsAging.ts` when they grew
 * the totals. The versions that lived here returned `getARAging` / `getAPAging`
 * verbatim: ten rows, no total, no rowsTotal, no truncated, no envelope. That
 * is the audit's finding, and answering "what are we owed" meant summing the
 * rows by hand. They are not re-exported.
 */

export const searchGlTool: McpTool = {
  name: 'search_gl',
  description:
    'General-ledger lines for one account over a date range, with running balance. Provide account_id or account_code plus from_date/to_date. Max 200 rows.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      account_code: { type: 'string' },
      from_date: { type: 'string', format: 'date' },
      to_date: { type: 'string', format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['from_date', 'to_date'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const accountId = strArg(args, 'account_id');
    const accountCode = strArg(args, 'account_code');
    const fromDate = strArg(args, 'from_date');
    const toDate = strArg(args, 'to_date');
    if (!accountId && !accountCode) return toolError('Provide account_id or account_code');
    if (!fromDate || !toDate) return toolError('from_date and to_date are required (YYYY-MM-DD)');
    // account_code is compared as TEXT, so it needs no cast guard.
    const bad = guardCastableArgs(args, {
      uuid: ['account_id'],
      date: ['from_date', 'to_date'],
    });
    if (bad) return bad;
    const result = await getAccountLedger({
      companyId: ctx.companyId, // from ctx ONLY
      accountId,
      accountCode,
      fromDate,
      toDate,
      limit: clampLimit(args, 100, 200),
    });
    return ok(result);
  },
};

/**
 * Row shape handed to the agent. Deliberately narrower than `GLAccount`:
 * `normal_balance`, `level`, `is_system_account` and `has_transactions` are
 * bookkeeping internals no allocate/journal argument takes.
 */
interface GlAccountRow {
  id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  account_subtype: string | null;
  is_active: boolean;
  parent_account_id: string | null;
}

export const listGlAccountsTool: McpTool = {
  name: 'list_gl_accounts',
  description:
    "The company's chart of accounts — resolve account codes to UUIDs in one call before allocate/journal tools, instead of one search_gl per code. " +
    'Optionally filter by account_type or by a case-insensitive substring of the code or name. ' +
    'Returns at most 500 rows per call (default 200), ordered by account_code. ' +
    'Paging: the reply carries next_cursor whenever more rows match; call again with cursor set and every other argument unchanged until next_cursor is null. total is the full match count.',
  scope: searchGlTool.scope,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      account_type: {
        type: 'string',
        enum: [...GL_ACCOUNT_TYPES],
        description: 'Restrict to one account type',
      },
      search: {
        type: 'string',
        description: 'Case-insensitive substring of account_code or account_name',
      },
      active_only: {
        type: 'boolean',
        description: 'Exclude deactivated accounts. Defaults to true.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 200, max 500' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const accountType = strArg(args, 'account_type');
    // Refuse an unknown type rather than filtering to nothing: an empty list
    // reads to an agent as "this company has no such accounts", which is a
    // wrong answer dressed as a right one.
    if (accountType !== undefined && !(GL_ACCOUNT_TYPES as readonly string[]).includes(accountType)) {
      return toolError(`invalid account_type — expected one of: ${GL_ACCOUNT_TYPES.join(', ')}`);
    }
    // `search` is compared as TEXT in JS, so it needs no cast guard.
    const search = strArg(args, 'search')?.toLowerCase();
    const activeOnly = args.active_only === undefined ? true : args.active_only !== false;

    // companyId from ctx ONLY.
    const accounts = await getChartOfAccounts(ctx.companyId, !activeOnly);
    const matched = accounts.filter((a) => {
      if (accountType !== undefined && a.accountType !== accountType) return false;
      if (search === undefined) return true;
      return (
        a.accountCode.toLowerCase().includes(search) ||
        a.accountName.toLowerCase().includes(search)
      );
    });

    // Total order (code, id) so paging is stable across identical codes.
    matched.sort(compareGlAccountKeys);
    const rawCursor = strArg(args, 'cursor');
    let start = 0;
    if (rawCursor !== undefined) {
      const cursor = decodeGlAccountCursor(rawCursor);
      if (!cursor) return toolError('invalid cursor');
      start = startIndexAfter(matched, cursor);
    }
    const limit = clampLimit(args, 200, 500);
    const page = matched.slice(start, start + limit);
    const last = page[page.length - 1];
    const nextCursor = last && start + limit < matched.length ? encodeGlAccountCursor(last) : null;

    const rows: GlAccountRow[] = page.map((a) => ({
      id: a.id,
      account_code: a.accountCode,
      account_name: a.accountName,
      account_type: a.accountType,
      account_subtype: a.accountSubtype ?? null,
      is_active: a.isActive,
      parent_account_id: a.parentAccountId ?? null,
    }));
    // `total` is the match count BEFORE the limit, so an agent can tell a
    // complete list from a truncated one and narrow instead of assuming.
    return ok({ accounts: rows, total: matched.length, next_cursor: nextCursor });
  },
};
