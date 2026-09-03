/**
 * Fiscal period reads: list them, get one, and run the close checklist.
 *
 * Nothing on the MCP surface could see a period before this. 56 prior periods
 * stand open on Brightsphere while its whole 2027 is closed — the control
 * running exactly backwards — and no client could observe it, let alone act on
 * it. An agent cannot respect a lock it cannot read.
 *
 * `list_fiscal_periods` therefore reports two things a plain listing would not:
 * `open_prior_periods`, which is the inversion as one number, and `alignment`,
 * which says whether the periods match the company's declared financial year.
 * Every production company declares a March start and every period runs
 * January–December, so a "fiscal year" here describes a span no set of
 * financial statements is ever signed for.
 */
import { fmtDate } from '@/lib/fmtDate';
import type { McpTool } from '../types';
import {
  getFiscalPeriods,
  getFiscalPeriodById,
  getJournalCountsByYear,
  resolveCompanyPeriodAlignment,
} from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import { buildEnvelope, encodeCursor, decodeCursor, figureBasis } from '../contracts';
import { NOT_FOUND, clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const STATUSES = ['open', 'closing', 'closed', 'locked'] as const;

function row(p: FiscalPeriod) {
  return {
    id: p.id,
    period_name: p.periodName,
    period_number: p.periodNumber,
    fiscal_year: p.fiscalYear,
    start_date: p.startDate,
    end_date: p.endDate,
    status: p.status,
    closed_at: p.closedAt ?? null,
  };
}

/** Sort key: fiscal year, then position in the year, then id for uniqueness. */
function keyOf(p: FiscalPeriod): string[] {
  return [String(p.fiscalYear).padStart(6, '0'), String(p.periodNumber).padStart(3, '0'), p.id];
}

function afterCursor(periods: FiscalPeriod[], cursor: string | undefined): FiscalPeriod[] | null {
  if (!cursor) return periods;
  const decoded = decodeCursor(cursor, 3);
  if (!decoded) return null;
  const target = decoded.parts.join(' ');
  return periods.filter((p) => keyOf(p).join(' ') > target);
}

export const listFiscalPeriodsTool: McpTool = {
  name: 'list_fiscal_periods',
  description:
    'Every fiscal period the company has, oldest first, with its dates and its status '
    + '(open, closing, closed or locked). This is the posting lock: a journal dated inside an open '
    + 'period posts, and one dated inside a closed or locked period is refused. '
    + 'Two fields exist because the control is commonly inverted and otherwise invisible. '
    + 'open_prior_periods counts periods that have ENDED and are still open — anyone can still post '
    + 'into them, and one production company has 56. alignment compares the period layout against '
    + 'companies.financial_year_start: when aligned is false the periods run January–December while '
    + 'the financial year does not, so a "fiscal year" here is not the year the financial statements '
    + 'cover. It does NOT tell you whether a period SHOULD be closed — call period_close_checklist '
    + 'for that. Read-only. Filter by fiscal_year or status; page with cursor.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_year: { type: 'number', description: 'e.g. 2027. Omit for every year.' },
      status: { type: 'string', enum: [...STATUSES] },
      limit: { type: 'number', description: 'Default 100, max 500.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page. Loop until it is null.' },
      detail: { type: 'string', enum: ['summary', 'standard'], description: 'summary returns totals only.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const status = strArg(args, 'status');
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      return toolError(`status must be one of: ${STATUSES.join(', ')}`);
    }
    const yearArg = args.fiscal_year;
    if (yearArg !== undefined && !Number.isInteger(yearArg)) {
      return toolError('fiscal_year must be a whole number');
    }
    const detail = strArg(args, 'detail') === 'summary' ? 'summary' : 'standard';
    const limit = clampLimit(args, 100, 500);

    const [all, alignment] = await Promise.all([
      getFiscalPeriods(ctx.companyId, yearArg as number | undefined),
      resolveCompanyPeriodAlignment(ctx.companyId),
    ]);

    // The caller's own status filter is a REQUEST parameter, not a
    // classification the report applied, so the universe is measured after it.
    const universe = status ? all.filter((p) => p.status === status) : all;
    const sorted = [...universe].sort((a, b) =>
      keyOf(a).join(' ') < keyOf(b).join(' ') ? -1 : 1);

    const remaining = afterCursor(sorted, strArg(args, 'cursor'));
    if (remaining === null) return toolError('invalid cursor');

    const page = detail === 'summary' ? [] : remaining.slice(0, limit);
    const last = page[page.length - 1];
    const more = detail !== 'summary' && remaining.length > page.length;

    // fmtDate, not toISOString: the latter is the UTC calendar day, and SAST is
    // UTC+2, so between midnight and 02:00 local it stamps YESTERDAY onto as_at.
    const today = fmtDate(new Date());
    const envelope = buildEnvelope({
      rows: page.map(row),
      rowsTotal: sorted.length,
      // universeTotal omitted: rows ARE the periods this company has; there is no wider pool they were selected from,
      // so a universe equal to rowsTotal would make the identity unfalsifiable.
      detail,
      as_at: today,
      // Periods are configuration, not ledger rows: the newest one created is
      // the only honest "through" available, and now() would prove nothing.
      posted_through: sorted.reduce<string>((acc, p) => (p.createdAt > acc ? p.createdAt : acc), ''),
      next_cursor: more && last ? encodeCursor({ parts: keyOf(last) }) : null,
      excludedRows: [],
    });

    return ok({
      ...envelope,
      open_prior_periods: all.filter((p) => p.status === 'open' && p.endDate < today).length,
      closed_periods: all.filter((p) => p.status === 'closed' || p.status === 'locked').length,
      alignment: {
        declared_start_month: alignment.declaredStartMonth,
        observed_start_month: alignment.observedStartMonth,
        aligned: alignment.aligned,
      },
    });
  },
};

export const getFiscalPeriodTool: McpTool = {
  name: 'get_fiscal_period',
  description:
    'One fiscal period by id, with its dates, its status and how many journal entries sit in it. '
    + 'Use it before posting a back-dated journal to check the period is open, and after '
    + 'close_fiscal_period to confirm the status changed. journal_entry_count is the number of '
    + 'entries whose fiscal_period_id is this period — a journal posted with NO period at all is '
    + 'counted nowhere and is invisible to the trial balance, so a count of zero on a period with '
    + 'trading in it is a finding, not a quiet month. Read-only.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_period_id: { type: 'string', description: 'Id from list_fiscal_periods.' },
    },
    required: ['fiscal_period_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'fiscal_period_id');
    if (!id) return toolError('fiscal_period_id is required');
    const bad = guardCastableArgs(args, { uuid: ['fiscal_period_id'] });
    if (bad) return bad;

    const period = await getFiscalPeriodById(ctx.companyId, id);
    if (!period) return toolError(NOT_FOUND);

    const counts = await getJournalCountsByYear(ctx.companyId, period.fiscalYear);
    return ok({ ...row(period), journal_entry_count: counts[period.id] ?? 0 });
  },
};

export const periodCloseChecklistTool: McpTool = {
  name: 'period_close_checklist',
  description:
    'Eight readiness checks for one fiscal period, as data: bank reconciled, unposted journals, '
    + 'AR ties to its control account, AP ties to its control account, VAT reviewed, trial balance '
    + 'balanced, opening-balance equity cleared, and journals outside every period. Each returns '
    + 'pass, fail or warn with the reason and the screen that fixes it. '
    + 'orphan_period_journals is the only COMPANY-scoped check: a posted journal with no fiscal '
    + 'period belongs to no period at all, so no period-scoped query can find it, and it is '
    + 'absent from the trial balance, the VAT201 and the AFS while sitting in the ledger. '
    + 'These checks are ADVISORY in the app — a person may close over them — but close_fiscal_period '
    + 'REFUSES on any failing check, so run this first to see what a close would refuse on. '
    + 'A check that could not be computed comes back as warn with the reason "Could not compute"; '
    + 'close_fiscal_period treats that as a blocker, because "the AP tie could not be checked" is '
    + 'exactly the state in which closing unattended is unsafe. Read-only, writes nothing.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_period_id: { type: 'string', description: 'Id from list_fiscal_periods.' },
    },
    required: ['fiscal_period_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'fiscal_period_id');
    if (!id) return toolError('fiscal_period_id is required');
    const bad = guardCastableArgs(args, { uuid: ['fiscal_period_id'] });
    if (bad) return bad;

    const readiness = await getCloseReadiness(ctx.companyId, id);
    if (!readiness) return toolError(NOT_FOUND);

    return ok({
      fiscal_period_id: readiness.periodId,
      period_label: readiness.periodLabel,
      overall_status: readiness.overallStatus,
      figure_basis: figureBasis('gl.trialbalance.v2'),
      items: readiness.items.map((i) => ({
        key: i.key, label: i.label, status: i.status, reason: i.reason, fix_href: i.fixHref,
      })),
    });
  },
};
