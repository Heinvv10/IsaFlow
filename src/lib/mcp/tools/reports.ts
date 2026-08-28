/**
 * MCP read tools: financial reports. Every handler calls the SAME service
 * function its REST route uses — tools never write SQL. companyId comes
 * from ctx ONLY (never from args).
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/neon';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getChartOfAccounts } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { GL_ACCOUNT_TYPES } from '@/modules/accounting/types/gl.types';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const trialBalanceTool: McpTool = {
  name: 'trial_balance',
  description:
    'Trial balance for the connected company for a fiscal period (defaults to the period containing today). Amounts in the company base currency.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_period_id: {
        type: 'string',
        description: 'Fiscal period UUID; defaults to the period containing today',
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['fiscal_period_id'] });
    if (bad) return bad;
    const periodId =
      strArg(args, 'fiscal_period_id') ??
      (await getFiscalPeriodIdForDate(ctx.companyId, new Date()));
    if (!periodId) {
      return toolError('No fiscal period covers today. Provide fiscal_period_id explicitly.');
    }
    const rows = await getTrialBalance(ctx.companyId, periodId);
    return ok({ fiscal_period_id: periodId, rows });
  },
};

export const profitAndLossTool: McpTool = {
  name: 'profit_and_loss',
  description:
    'Income statement (profit & loss) for a date range. Both dates required, YYYY-MM-DD.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date' },
      period_end: { type: 'string', format: 'date' },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;
    return ok(await getIncomeStatement(ctx.companyId, start, end));
  },
};

export const balanceSheetTool: McpTool = {
  name: 'balance_sheet',
  description: 'Balance sheet as at a date (YYYY-MM-DD; defaults to today).',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;
    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
    return ok(await getBalanceSheet(ctx.companyId, asAt));
  },
};

export const agedDebtorsTool: McpTool = {
  name: 'aged_debtors',
  description:
    'Accounts-receivable aging buckets per customer as at a date (defaults to today).',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;
    return ok(await getARAging(ctx.companyId, strArg(args, 'as_at')));
  },
};

export const agedCreditorsTool: McpTool = {
  name: 'aged_creditors',
  description:
    'Accounts-payable aging buckets per supplier as at a date (defaults to today).',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;
    return ok(await getAPAging(ctx.companyId, strArg(args, 'as_at')));
  },
};

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
    'Returns at most 500 rows (default 200) with no pagination: a company with more accounts than that should narrow with search or account_type.',
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

    const rows: GlAccountRow[] = matched.slice(0, clampLimit(args, 200, 500)).map((a) => ({
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
    return ok({ accounts: rows, total: matched.length });
  },
};
