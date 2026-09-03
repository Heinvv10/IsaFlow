/**
 * `bank_statement_coverage` and `get_opening_balances` — the two reads that
 * make a bank account's completeness checkable.
 *
 * 203 statement lines were missing from Velocity Fibre's primary account and
 * were found only by holding IsaFlow next to Sage. Coverage finds that shape
 * without a second system. `set_opening_balance` has always written and nothing
 * has ever read back, so no GL-versus-bank comparison was possible at all.
 */
import type { McpTool } from '../types';
import {
  getBankStatementCoverage,
  DEFAULT_MIN_GAP_DAYS,
} from '@/modules/accounting/services/bank/bankStatementCoverageService';
import { getOpeningBalances } from '@/modules/accounting/services/gl/openingBalanceReadService';
import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { buildEnvelope, figureBasis } from '../contracts';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** Today as YYYY-MM-DD, from local components — never toISOString(). */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const bankStatementCoverageTool: McpTool = {
  name: 'bank_statement_coverage',
  description:
    'Whether a company\'s imported bank history can account for itself, per bank account. '
    + 'Returns first and last transaction date, transaction count, count and net movement by month, '
    + 'runs of consecutive days with no transaction (day-level gaps), references carried by more '
    + 'than one transaction, the recorded opening balance, and THREE balances kept separate: '
    + 'gl_balance (what the ledger says), statement_balance (what the imported lines sum to) and '
    + 'computed_balance (opening balance plus those lines). gl_vs_computed_difference is the gap '
    + 'between the first and the third — on one production company it is R2.4m and on another R6.5m. '
    + 'They are NEVER netted into one figure: the gap is the finding. '
    + 'Covers every account of subtype bank INCLUDING deactivated ones, because a deactivated '
    + 'account still holds money. '
    + 'What it cannot do: it cannot see a transaction that was never imported. A gap is evidence '
    + 'that lines are missing; the ABSENCE of a gap is not evidence that they are all there, since '
    + 'a whole month missing from the start or the end of the history leaves no gap between two '
    + 'dates. Use stale_days and the month table against the statements you hold. '
    + 'Read-only. Narrow with bank_account_id (a GL account id from bank_accounts_status).',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: {
        type: 'string',
        description: 'Optional. A bank GL account id. Omit for every bank account.',
      },
      as_at: {
        type: 'string',
        format: 'date',
        description: 'YYYY-MM-DD. Everything is bounded at this date. Defaults to today.',
      },
      min_gap_days: {
        type: 'number',
        description:
          `Shortest run of empty days worth reporting. Default ${DEFAULT_MIN_GAP_DAYS}. `
          + 'Weekends make two-day gaps ordinary, so a low value returns noise.',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'standard', 'full'],
        description:
          'summary returns the totals only; standard returns one row per account without the '
          + 'month table; full adds months, gaps and duplicate references.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const bad = guardCastableArgs(args, { uuid: ['bank_account_id'], date: ['as_at'] });
    if (bad) return bad;

    const minGapArg = args.min_gap_days;
    if (minGapArg !== undefined && (!Number.isInteger(minGapArg) || (minGapArg as number) < 1)) {
      return toolError('min_gap_days must be a whole number of at least 1');
    }

    const detailArg = strArg(args, 'detail');
    const detail = detailArg === 'summary' || detailArg === 'full' ? detailArg : 'standard';
    const asAt = strArg(args, 'as_at') ?? todayIso();

    // Ownership before the service call: bank_account_id becomes a foreign key
    // and nothing downstream re-checks the tenant. A distinct "another
    // company's" reply would be an existence oracle, so it is the shared miss.
    if (bankAccountId && !(await bankGlAccountBelongsToCompany(ctx.companyId, bankAccountId))) {
      return toolError(NOT_FOUND);
    }

    const coverage = await getBankStatementCoverage(ctx.companyId, {
      asAt,
      bankAccountId,
      minGapDays: minGapArg as number | undefined,
    });

    const rows = detail === 'summary' ? [] : coverage.accounts.map((a) => ({
      bank_account_id: a.bankAccountId,
      account_code: a.accountCode,
      account_name: a.accountName,
      is_active: a.isActive,
      first_transaction_date: a.firstTransactionDate,
      last_transaction_date: a.lastTransactionDate,
      stale_days: a.staleDays,
      transaction_count: a.transactionCount,
      gl_balance: a.glBalance,
      statement_balance: a.statementBalance,
      computed_balance: a.computedBalance,
      gl_vs_computed_difference: a.glVsComputedDifference,
      opening_balance: a.openingBalance,
      gap_count: a.gaps.length,
      duplicate_reference_group_count: a.duplicateReferences.length,
      ...(detail === 'full'
        ? {
          months: a.months,
          gaps: a.gaps,
          duplicate_references: a.duplicateReferences,
        }
        : {}),
    }));

    return ok({
      ...buildEnvelope({
        rows,
        rowsTotal: coverage.accounts.length,
        // universeTotal omitted: rows ARE the accounts/rows this report builds; nothing is filtered out of a wider candidate set,
        // so a universe equal to rowsTotal would make the identity unfalsifiable.
        detail,
        as_at: coverage.asAt,
        posted_through: coverage.postedThrough ?? '',
        next_cursor: null,
        excludedRows: [],
        figureBasis: figureBasis('cash.ledger.v1'),
      }),
      totals: coverage.totals,
    });
  },
};

export const getOpeningBalancesTool: McpTool = {
  name: 'get_opening_balances',
  description:
    'The opening balance recorded for each bank account, from BOTH places it is stored, so they '
    + 'can be compared. posted_amount is the net of the opening-balance journals actually in the '
    + 'ledger (source auto_migration) and carries the journal ids behind it; metadata_amount is '
    + 'gl_accounts.bank_opening_balance, which the banking screens display and which no balance '
    + 'calculation ever adds. set_opening_balance writes both; the bank-account editor writes only '
    + 'the second, so an account can show a figure on screen that the ledger has never seen. '
    + '`agrees` is false when they differ by a cent or more, and `disagreements` lists exactly '
    + 'those accounts — that gap is the finding, and the two numbers are never reconciled into one. '
    + 'accounts_without_opening_balance lists accounts with neither: the column DEFAULTS to 0.00 '
    + 'rather than NULL, and set_opening_balance refuses a zero, so a stored zero means unset. '
    + 'Covers deactivated accounts too. Read-only.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: { type: 'string', description: 'Optional. Narrow to one bank GL account.' },
      detail: { type: 'string', enum: ['summary', 'standard'] },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const bad = guardCastableArgs(args, { uuid: ['bank_account_id'] });
    if (bad) return bad;
    if (bankAccountId && !(await bankGlAccountBelongsToCompany(ctx.companyId, bankAccountId))) {
      return toolError(NOT_FOUND);
    }
    const detail = strArg(args, 'detail') === 'summary' ? 'summary' : 'standard';

    const balances = await getOpeningBalances(ctx.companyId, bankAccountId);

    return ok({
      ...buildEnvelope({
        rows: detail === 'summary' ? [] : balances.rows.map((r) => ({
          account_id: r.accountId,
          account_code: r.accountCode,
          account_name: r.accountName,
          is_active: r.isActive,
          posted_amount: r.postedAmount,
          posted_as_at: r.postedAsAt,
          metadata_amount: r.metadataAmount,
          metadata_as_at: r.metadataAsAt,
          agrees: r.agrees,
          journal_entry_ids: r.journalEntryIds,
          entry_numbers: r.entryNumbers,
        })),
        rowsTotal: balances.rows.length,
        // universeTotal omitted: rows ARE the accounts/rows this report builds; nothing is filtered out of a wider candidate set,
        // so a universe equal to rowsTotal would make the identity unfalsifiable.
        detail,
        as_at: todayIso(),
        posted_through: balances.postedThrough ?? '',
        next_cursor: null,
        excludedRows: [],
      }),
      totals: balances.totals,
      disagreement_count: balances.disagreements.length,
      disagreements: balances.disagreements.map((r) => ({
        account_code: r.accountCode,
        posted_amount: r.postedAmount,
        metadata_amount: r.metadataAmount,
      })),
      accounts_without_opening_balance: balances.accountsWithoutOpeningBalance,
    });
  },
};
