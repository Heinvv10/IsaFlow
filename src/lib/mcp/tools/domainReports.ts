/**
 * MCP read tools: customer statement, project profitability, work in progress.
 *
 * Three WRAPs over services the UI already proves. What each adds is the
 * completeness statement — and on these books, twice over, that statement IS
 * the finding rather than a footnote to it.
 *
 * `project_profitability` is the clearest case. It returns an empty array on
 * every one of these companies, because zero of 39,285 journal lines carries a
 * project_id and there are no project rows at all. `rows: []` reads as "no
 * projects were unprofitable". The disclosure carrying the untagged P&L amount
 * is what turns it into "none of your P&L is tagged to a project".
 */
import type { McpTool } from '../types';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import {
  getProjectProfitability,
  getProjectTaggingCoverage,
} from '@/modules/accounting/services/reports/projectProfitabilityService';
import { getWipByClient } from '@/modules/accounting/services/practice/practiceWipService';
import { buildEnvelope, figureBasis, isDetailLevel } from '../contracts';
import type { DetailLevel, ExcludedRow } from '../contracts';
import { guardCastableArgs, NOT_FOUND, ok, strArg, toolError } from './toolHelpers';
import { fmtDate } from '@/lib/fmtDate';

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';

function detailOf(args: Record<string, unknown>): DetailLevel {
  const raw = strArg(args, 'detail');
  return raw && isDetailLevel(raw) ? raw : 'standard';
}

export const customerStatementTool: McpTool = {
  name: 'customer_statement',
  description:
    'A running-balance statement of account for one customer: every invoice, receipt and credit note dated on or before as_at, in date order, with the balance after each. This is what you send a debtor when you chase them. ' +
    'It runs from INCEPTION to as_at, not over a rolling window — from_date reports the date of the earliest transaction it actually found. ' +
    'Invoices appear at their full value; the statement does not net payments off individual invoices, it lists them as separate credits, so the closing balance is what the customer owes overall rather than an age analysis. Use aged_debtors for ageing. ' +
    'Cancelled invoices are omitted. A receipt that has not been confirmed or reconciled does NOT reduce the balance and appears in excludedRows with its amount, because a customer who has paid you money nobody has confirmed is a different problem from one who has not paid. Credit notes count whether they are approved or already applied to an invoice. ' +
    'Every excluded row names a machine-stable reason and, where it has one, its amount. detail: "summary" returns the totals with no rows; "standard" and "full" return the transactions.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'Customer UUID from list_customers.' },
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    required: ['customer_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['customer_id'], date: ['as_at'] });
    if (guard) return guard;
    const customerId = strArg(args, 'customer_id');
    if (!customerId) return toolError('customer_id is required');

    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
    const detail = detailOf(args);

    // The service is company-scoped and returns null for a customer in another
    // tenant, which must read identically to a genuine miss.
    const data = await fetchStatementData(ctx.companyId, customerId, asAt);
    if (!data) return toolError(NOT_FOUND);

    const rows = data.transactions.map((t) => ({
      date: t.date,
      type: t.type,
      reference: t.reference,
      debit: t.debit,
      credit: t.credit,
      balance: t.balance,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      universeTotal: data.universeTotal,
      detail,
      as_at: asAt,
      // A statement is assembled from documents, not from journal rows; the
      // latest document date it consumed is the honest re-derivation pin.
      posted_through: rows.length > 0 ? `${rows[rows.length - 1]!.date}T00:00:00.000Z` : NO_LEDGER_ROWS,
      excludedRows: data.excluded as ExcludedRow[],
      figureBasis: figureBasis('ar.subledger.v1'),
    });

    return ok({
      ...envelope,
      customer: data.customer,
      from_date: data.fromDate,
      summary: data.summary,
    });
  },
};

export const projectProfitabilityTool: McpTool = {
  name: 'project_profitability',
  description:
    'Per-project profit and loss over a date range, built from posted journal lines that carry a project reference: revenue, direct cost, profit and margin for each project, with the account-level lines behind them. ' +
    'READ THE COVERAGE BEFORE THE ROWS. Only journal lines tagged with a project_id can appear here, and an untagged ledger produces an EMPTY result that looks identical to a company with no unprofitable projects. project_tag_coverage reports how many P&L lines in the range are tagged, how many are not, and what the untagged movement is worth. It sits OUTSIDE the completeness envelope on purpose: untagged lines are not projects, so they are a disclosure about data this report could not attribute rather than rows excluded from its universe. On the books this was built against, that total is 100% of P&L. ' +
    'It draws only on the general ledger. Time entries, work items and purchase orders that have never been journalised do not appear, so a project can look costless because nobody posted its costs. It is not a job-cost report and it does not accrue work in progress — see wip_report for unbilled time. ' +
    'as_at is the END of the range. Margin is profit as a percentage of revenue, and is zero when there is no revenue rather than infinite.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      period_end: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (guard) return guard;
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    if (end < start) return toolError('period_end must not precede period_start');

    const detail = detailOf(args);
    const [reports, coverage] = await Promise.all([
      getProjectProfitability(ctx.companyId, start, end),
      getProjectTaggingCoverage(ctx.companyId, start, end),
    ]);

    const rows = reports.map((r) => ({
      project_id: r.projectId,
      project_name: r.projectName,
      revenue: r.revenue,
      costs: r.costs,
      profit: r.profit,
      margin_pct: r.margin,
      ...(detail === 'full'
        ? { revenue_lines: r.revenueLines, cost_lines: r.costLines }
        : {}),
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      // universeTotal omitted: these rows ARE the population of projects with
      // movement in the range. The previous expression said the universe was
      // "projects plus the untagged bucket" — the sum of the two quantities
      // buildEnvelope checks, so it could not fail, and it counted a bucket of
      // journal LINES as though it were one more project.
      //
      // excludedRows is empty for the same reason: untagged movement is a
      // DISCLOSURE, not an exclusion. Those lines were never members of the
      // universe of projects. They are reported in full, unaggregated, by
      // `project_tag_coverage` below — outside the identity, where they belong.
      detail,
      as_at: end,
      posted_through: coverage.postedThrough ?? NO_LEDGER_ROWS,
      excludedRows: [],
    });

    return ok({
      ...envelope,
      period_start: start,
      period_end: end,
      project_tag_coverage: {
        tagged_lines: coverage.taggedLines,
        untagged_lines: coverage.untaggedLines,
        untagged_amount: coverage.untaggedAmount,
      },
    });
  },
};

export const wipReportTool: McpTool = {
  name: 'wip_report',
  description:
    'Unbilled work in progress for an accounting practice, one row per practice client: total hours, total value at the rate that was applied when the time was logged, and the date of the OLDEST piece of unbilled work — which is the number that tells you where the practice is losing money. ' +
    'It counts APPROVED, billable time that has not yet been billed. It does NOT count time still in draft or submitted, non-billable time, leave, or time already written off or invoiced — so it understates total unbilled effort, and a client with hours sitting in draft shows as having no WIP at all. Use list_time_entries with a status filter to see those. ' +
    'This is practice time, not project costing: it reads the practice time-entry ledger and has nothing to do with journal entries, so nothing here has reached the general ledger. Value is hours times the applied rate and carries no VAT. ' +
    'detail: "full" returns the individual time entries behind each client total, so you can see what the work was. Filter by practice_client_id, partner, or entry-date range.',
  scope: 'read:practice',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      practice_client_id: { type: 'string', description: 'Practice client UUID from list_practice_clients.' },
      partner_id: { type: 'string', description: 'Assigned partner UUID.' },
      date_from: { type: 'string', format: 'date', description: 'Inclusive entry date, YYYY-MM-DD.' },
      date_to: { type: 'string', format: 'date', description: 'Inclusive entry date, YYYY-MM-DD.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, {
      uuid: ['practice_client_id', 'partner_id'],
      date: ['date_from', 'date_to'],
    });
    if (guard) return guard;

    const detail = detailOf(args);
    const clients = await getWipByClient(ctx.companyId, {
      practiceClientId: strArg(args, 'practice_client_id'),
      partnerId: strArg(args, 'partner_id'),
      dateFrom: strArg(args, 'date_from'),
      dateTo: strArg(args, 'date_to'),
    });

    const rows = clients.map((c) => ({
      practice_client_id: c.practiceClientId,
      legal_name: c.legalName,
      link_customer_id: c.linkCustomerId,
      total_hours: c.totalHours,
      total_value: c.totalValue,
      oldest_approved_date: c.oldestApprovedDate,
      ...(detail === 'full' ? { entries: c.entries } : {}),
    }));

    const asAt = strArg(args, 'date_to') ?? fmtDate(new Date());
    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      // universeTotal omitted: WIP rows are produced per client from approved
      // time, not selected out of a wider candidate set, and excludedRows is
      // always empty — so the identity reduced to rowsTotal === rowsTotal.
      detail,
      as_at: asAt,
      // Time entries are not ledger rows; the oldest approved date is the only
      // pin the source offers, so the latest one it served stands in.
      posted_through: rows.length > 0
        ? `${rows.map((r) => r.oldest_approved_date).sort().slice(-1)[0]}T00:00:00.000Z`
        : NO_LEDGER_ROWS,
      excludedRows: [],
    });

    return ok({
      ...envelope,
      total_hours: rows.reduce((s, r) => s + r.total_hours, 0),
      total_value: rows.reduce((s, r) => s + r.total_value, 0),
    });
  },
};
