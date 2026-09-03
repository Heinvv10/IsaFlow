/**
 * `trial_balance` v2 — a WRAP of `getTrialBalanceReport`, not a rewrite.
 *
 * The service already computes the rows, the totals, the difference and the
 * balanced assertion, against the ONE exported `BALANCE_TOLERANCE`. This tool
 * consumes them. It does not recompute the assertion, because three callers
 * each rolling their own is exactly how a 7-of-118-account listing came to be
 * stamped "Difference R0.00 · Balanced".
 *
 * `accountCount` is surfaced for the same reason: that defect was a SCOPE
 * failure, not an arithmetic one, and an assertion that does not say what it
 * covers reproduces the bug inside a response that looks verified.
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import {
  BALANCE_TOLERANCE,
  getTrialBalanceReport,
} from '@/modules/accounting/services/gl/trialBalanceService';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getLedgerPostedThrough } from '@/modules/accounting/services/reports/postedThroughService';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import {
  buildEnvelope,
  decodeCursor,
  encodeCursor,
  figureBasis,
  isDetailLevel,
  type DetailLevel,
} from '@/lib/mcp/contracts';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/**
 * A total order for paging. `accountCode` is unique per company, but the
 * derived brought-forward row is not a real account, so the name is appended to
 * keep the order total if a duplicate code ever appears.
 */
function sortKey(r: TrialBalanceRow): string {
  return `${r.accountCode} ${r.accountName}`;
}

const DESCRIPTION = [
  'Trial balance for a fiscal period: EVERY account with its opening balance, the period movement and the closing balance, plus the balanced assertion over exactly the accounts returned.',
  'Balance-sheet accounts are cumulative from inception; income-statement accounts are year-to-date within the fiscal year, taken from companies.financial_year_start (every production company here starts in March, not January).',
  'debitBalance/creditBalance carry the NET closing balance on the account own side, not gross turnover — do not sum them expecting turnover. periodDebit/periodCredit are the turnover.',
  'accountCount states how many accounts the balanced assertion covers, and you should check it: a trial balance that omits accounts without movement is a period-movement listing wearing a trial balance name, which is how this report once reported 7 of 118 accounts as Balanced.',
  'include_zero_balances separates three states that are NOT the same question. An account carrying a balance but with no movement this period is ALWAYS returned. An account whose postings net to zero is returned only with the flag on. An account never posted to is never returned.',
  'A row with derived:true is computed (the retained-earnings brought-forward line) and has no journal behind it — exclude it when tying this report to the ledger.',
  'Paginated: call again with cursor until next_cursor is null. rowsTotal is the full account count, not the size of the page.',
].join(' ');

export const trialBalanceTool: McpTool = {
  name: 'trial_balance',
  description: DESCRIPTION,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_period_id: {
        type: 'string',
        description: 'Fiscal period UUID; defaults to the period containing today.',
      },
      cost_centre_id: { type: 'string', description: 'Restrict to one cost centre.' },
      include_zero_balances: {
        type: 'boolean',
        description: 'Include accounts whose balance AND movement both net to zero. Default false.',
      },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 200.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['fiscal_period_id', 'cost_centre_id'] });
    if (bad) return bad;

    // Decoded BEFORE the query: a read tool runs with no savepoint, so nothing
    // may throw after the query has run.
    const rawCursor = strArg(args, 'cursor');
    let after: string | null = null;
    if (rawCursor !== undefined) {
      const decoded = decodeCursor(rawCursor, 1);
      if (!decoded) return toolError('invalid cursor');
      after = decoded.parts[0]!;
    }
    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';

    const periodId =
      strArg(args, 'fiscal_period_id') ??
      (await getFiscalPeriodIdForDate(ctx.companyId, new Date()));
    if (!periodId) {
      return toolError('No fiscal period covers today. Provide fiscal_period_id explicitly.');
    }

    // companyId from ctx ONLY. The REPORT, never getTrialBalance, because the
    // report is the one place the balanced assertion is computed.
    const report = await getTrialBalanceReport(ctx.companyId, periodId, {
      costCentreId: strArg(args, 'cost_centre_id'),
      includeZeroBalances: args.include_zero_balances === true,
    });

    const sorted = [...report.rows].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const start = after === null ? 0 : sorted.findIndex((r) => sortKey(r) === after) + 1;
    const limit = clampLimit(args, 200, 500);
    const page = sorted.slice(start, start + limit);
    const last = page[page.length - 1];
    const nextCursor =
      last && start + limit < sorted.length ? encodeCursor({ parts: [sortKey(last)] }) : null;

    const asAt = report.periodEnd || fmtDate(new Date());
    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : page,
      // The SERVICE's count of the rows its assertion covers. Taking it from
      // the service rather than from the page is what makes rowsTotal mean
      // "what was asserted over" rather than "what was served".
      rowsTotal: report.accountCount,
      detail,
      as_at: asAt,
      posted_through: await getLedgerPostedThrough(ctx.companyId, asAt),
      next_cursor: nextCursor,
      // Nothing is excluded — the whole point of v2 is that no account is
      // dropped — so the universe is the account count.
      universeTotal: report.accountCount,
      figureBasis: figureBasis('gl.trialbalance.v2'),
    });

    return ok({
      ...envelope,
      fiscal_period_id: report.fiscalPeriodId,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      fiscalYearStart: report.fiscalYearStart,
      accountCount: report.accountCount,
      totalDebit: report.totalDebit,
      totalCredit: report.totalCredit,
      // Straight from the service. Recomputing either of these here is the
      // defect this tool exists to stop repeating.
      difference: report.difference,
      balanced: report.balanced,
      balanceTolerance: BALANCE_TOLERANCE,
    });
  },
};
