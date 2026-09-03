/**
 * MCP read tool: the integrity check suite.
 *
 * Thirteen questions an auditor asks, in one call. Every one is drawn from a
 * finding that took hours to locate by hand on a live book: an invoice with no
 * due date hiding R1,058,000 from the aging, 2,114 bank transactions showing
 * "No VAT" over a claim, R14,081,940.13 in a clearing account that should be
 * nil, R9.8m of asset accounts sitting in credit.
 *
 * This is the cheapest endpoint in the programme and it catches the most.
 */
import type { McpTool } from '../types';
import { buildEnvelope } from '../contracts';
import {
  INTEGRITY_CHECK_IDS,
  isIntegrityCheckId,
  runIntegrityChecks,
  type IntegrityCheckId,
} from '@/modules/accounting/services/gl/integrityChecks';
import { getChartOfAccountsHealth } from '@/modules/accounting/services/gl/chartOfAccountsHealthService';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

function requestedChecks(args: Record<string, unknown>): IntegrityCheckId[] | 'invalid' | undefined {
  const raw = args.checks;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return 'invalid';
  const ids: IntegrityCheckId[] = [];
  for (const v of raw) {
    if (!isIntegrityCheckId(v)) return 'invalid';
    if (!ids.includes(v)) ids.push(v);
  }
  return ids;
}

/** Today in ISO, for the default reporting date. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const dataIntegrityChecksTool: McpTool = {
  name: 'data_integrity_checks',
  description:
    'Runs a suite of thirteen integrity checks over the ledger and returns, for each, how many rows fail it, the money behind them, and a sample you can go and open. '
    + 'Checks: invoices_null_due_date (invisible in the aging) · vat_displayed_differs_from_posted (the bank screen shows no VAT and the journal claims it) · journal_date_differs_from_bank_date (a day decides the VAT period) · duplicate_bank_references (the reference is not a key) · deactivated_accounts_with_balance · asset_accounts_with_credit_balance · cost_of_sales_typed_as_expense (gross profit) · clearing_accounts_not_nil · duplicate_control_accounts (two accounts receiving one role) · documents_outside_open_period · stale_suggested_transactions (look done, not in the GL) · test_records_in_production · invoices_without_revenue_line. '
    + 'Pass checks:[...] to run a subset; omit it to run all thirteen. as_at scopes every check to a reporting date and defaults to today. limit caps the SAMPLE only — count and amount are always over every failing row, so count > sample.length simply means there are more. '
    + 'READ THIS BEFORE ACTING ON A ZERO: a check whose query failed comes back with count -1 and appears in excludedRows. That is "unknown", not "clean", and it is the one result you must never treat as a pass. '
    + 'LIMITS: this reports, it never fixes anything and never changes a row. Two checks (clearing_accounts_not_nil, cost_of_sales_typed_as_expense) match on the account NAME, because no subtype records the intent — they compare the name against the type rather than computing from it, so a differently-named clearing account is not found.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      checks: {
        type: 'array',
        items: { type: 'string', enum: [...INTEGRITY_CHECK_IDS] },
        description: 'Subset to run. Omit for all thirteen.',
      },
      as_at: { type: 'string', format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Sample rows per check. Never caps count or amount.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const checks = requestedChecks(args);
    if (checks === 'invalid') {
      return toolError(`checks must be a non-empty array of: ${INTEGRITY_CHECK_IDS.join(', ')}`);
    }
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;
    const asAt = strArg(args, 'as_at') ?? todayIso();

    const report = await runIntegrityChecks(ctx.companyId, {
      checks,
      asAt,
      limit: clampLimit(args, 20, 100),
    });

    // A check that did not run is a row this report could not classify. It goes
    // in excludedRows rather than being served beside the twelve that worked,
    // where a reader scanning counts would read its -1 as "nothing found".
    const ran = report.checks.filter((c) => c.count >= 0);
    const excludedRows = report.checks
      .filter((c) => c.count < 0)
      .map((c) => ({
        id: c.id,
        reason: 'check_did_not_run',
        detail: c.finding,
      }));

    return ok({
      failingRowsTotal: report.failingRowsTotal,
      checksFailed: report.checksFailed,
      checksRun: ran.length,
      ...buildEnvelope({
        rows: ran,
        rowsTotal: ran.length,
        universeTotal: report.checks.length,
        excludedRows,
        detail: 'standard',
        as_at: report.asAt,
        posted_through: report.postedThrough,
      }),
    });
  },
};

export const chartOfAccountsHealthTool: McpTool = {
  name: 'chart_of_accounts_health',
  description:
    'Audits the chart of accounts itself: accounts with no subtype, subtypes that do not belong to their account type, accounts never posted to, deactivated accounts still carrying a balance, duplicated codes, two accounts that are the same account under different codes, and whether an imported chart and the system chart are running on top of each other. '
    + 'Returns a summary with a count per finding, the flagged accounts (worst first, then largest balance), and missingSystemAccounts — roles with NO system account, which is a hard failure rather than untidiness because every auto-posting path that needs one throws. '
    + 'WHY IT MATTERS: none of this unbalances a trial balance, which is why it survives. An account with no subtype is invisible to the income statement bucketing, the VAT201 and the system account resolver, and lands in whatever the default happens to be — that is how R81m of cost of sales was reported as operating expenses. '
    + 'LIMITS: it reports and changes nothing. overlaidCharts is only as good as the imported_from column: a chart imported before that column was populated reads as a single chart, so treat false as "not detected" rather than "not happening". Duplicate NAMES are matched after collapsing case and punctuation; two accounts that are the same account under different names are not found.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;
    const asAt = strArg(args, 'as_at') ?? todayIso();
    const report = await getChartOfAccountsHealth(ctx.companyId, asAt, clampLimit(args, 200, 500));

    return ok({
      summary: report.summary,
      missingSystemAccounts: report.missingSystemAccounts,
      // The chart's completeness is stated HERE rather than through the
      // envelope's universeTotal identity, and deliberately. `universeTotal`
      // asks "rowsTotal + excluded = the universe you drew from", and an
      // account with nothing wrong with it is neither included nor excluded —
      // it is classified as clean. Passing the whole chart as the universe
      // would raise a completeness fault on every healthy account. These two
      // numbers are computed over every account in the chart, as are
      // summary.findingCounts; only the ROW LISTING is capped, which is what
      // rowsTotal and truncated report.
      accountsTotal: report.universeTotal,
      accountsClean: report.universeTotal - report.rowsTotal,
      ...buildEnvelope({
        rows: report.rows,
        rowsTotal: report.rowsTotal,
        excludedRows: [],
        detail: 'standard',
        as_at: report.asAt,
        posted_through: report.postedThrough,
      }),
    });
  },
};
