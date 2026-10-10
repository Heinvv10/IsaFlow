/**
 * MCP read tools: customer statement, project profitability, work in progress.
 *
 * All three WRAP a service the UI already proves. The value each adds over the
 * bare service is the completeness statement, and in two cases that statement
 * IS the finding:
 *
 *   - `project_profitability` returns an empty array on every one of these
 *     companies, because ZERO of 39,285 journal lines carries a project_id and
 *     there are no project rows at all. An empty list reads as "no projects
 *     were unprofitable"; the envelope has to say "R<x> of P&L is tagged to no
 *     project" instead.
 *   - `wip_report` counts only approved, unbilled, billable time. Everything
 *     still sitting in draft is unbilled work too, and a report that shows one
 *     without the other understates what the practice is owed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ar/statementEmailService', () => ({
  fetchStatementData: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/projectProfitabilityService', () => ({
  getProjectProfitability: vi.fn(),
  getProjectTaggingCoverage: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceWipService', () => ({
  getWipByClient: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/jobCostService', () => ({
  getJobCostReport: vi.fn(),
}));

import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import {
  getProjectProfitability,
  getProjectTaggingCoverage,
} from '@/modules/accounting/services/reports/projectProfitabilityService';
import { getWipByClient } from '@/modules/accounting/services/practice/practiceWipService';
import { getJobCostReport } from '@/modules/accounting/services/practice/jobCostService';

import {
  customerStatementTool,
  projectProfitabilityTool,
  wipReportTool,
} from '@/lib/mcp/tools/domainReports';
import { jobCostReportTool } from '@/lib/mcp/tools/jobCost';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';
const CUSTOMER = '44444444-4444-4444-4444-444444444444';

const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333',
  companyId: COMPANY,
  scopes: ['read:reports', 'read:practice'],
  tokenJti: 'j',
  oauthAppId: null,
};

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

const STATEMENT = {
  customer: { id: CUSTOMER, name: 'Blitz Fibre', email: 'ap@blitz.example' },
  fromDate: '2026-01-15',
  toDate: '2026-03-31',
  transactions: [
    { date: '2026-01-15', type: 'invoice', reference: 'INV0001', debit: 10000, credit: 0, balance: 10000 },
    { date: '2026-02-01', type: 'payment', reference: 'PMT0001', debit: 0, credit: 4000, balance: 6000 },
  ],
  excluded: [
    { id: 'p2', reason: 'payment_not_confirmed', detail: "Receipt is 'draft'", amount: 50000, documentNumber: 'PMT0002' },
  ],
  universeTotal: 3,
  summary: { totalInvoiced: 10000, totalPaid: 4000, totalCredits: 0, balance: 6000 },
};

/** WIP sees 1,700 of this; the submitted 85,000 is invisible to it. */
const JOB_COST = {
  rows: [{
    groupId: 'pc1', groupName: 'Weszak Beleggings',
    byStatus: {
      approved: { hours: 2, value: 1700, entries: 1 },
      submitted: { hours: 100, value: 85000, entries: 50 },
    },
    totalHours: 102, totalValue: 86700, unbilledValue: 86700, unbilledHours: 102,
  }],
  rowsTotal: 1,
  universeTotal: 2,
  excluded: [{ id: 'ungrouped', reason: 'no_client', detail: '3 time entries carry no client', amount: 1200 }],
  totals: { hours: 102, value: 86700, unbilledValue: 86700 },
  postedThrough: '2026-08-01T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchStatementData).mockResolvedValue(STATEMENT);
  vi.mocked(getProjectProfitability).mockResolvedValue([]);
  vi.mocked(getProjectTaggingCoverage).mockResolvedValue({
    taggedLines: 0, untaggedLines: 18752, untaggedAmount: 9554153.53,
    postedThrough: '2026-09-01T10:00:00.000Z',
  });
  vi.mocked(getWipByClient).mockResolvedValue([]);
  vi.mocked(getJobCostReport).mockResolvedValue(JOB_COST);
});

describe('registration', () => {
  it('all three are registered and mirrored in the client list', () => {
    for (const n of ['customer_statement', 'project_profitability', 'wip_report']) {
      expect(MCP_TOOLS.map((t) => t.name)).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
    }
  });

  it('none of them writes', () => {
    for (const t of [customerStatementTool, projectProfitabilityTool, wipReportTool]) {
      expect(t.write).toBe(false);
      expect(t.requiresPost).toBeUndefined();
    }
  });
});

describe('customer_statement', () => {
  it('carries the excluded rows and their amounts through to the envelope', async () => {
    const env = json(await customerStatementTool.handler(
      { customer_id: CUSTOMER, as_at: '2026-03-31' }, ctx,
    ));
    expect(env.excludedRows[0].reason).toBe('payment_not_confirmed');
    expect(env.excludedRows[0].amount).toBe(50000);
    // 2 included + 1 excluded = the universe of 3. Arithmetic somebody else
    // can check, not a claim the report makes about itself.
    expect(env.rowsTotal + env.excludedRows.length).toBe(3);
    expect(env.completenessFault).toBeUndefined();
  });

  it('reports the coverage window the statement actually used', async () => {
    const env = json(await customerStatementTool.handler(
      { customer_id: CUSTOMER, as_at: '2026-03-31' }, ctx,
    ));
    expect(env.as_at).toBe('2026-03-31');
    expect(env.from_date).toBe('2026-01-15');
  });

  it('takes the company from the context, never from args', async () => {
    await customerStatementTool.handler(
      { customer_id: CUSTOMER, as_at: '2026-03-31', company_id: OTHER }, ctx,
    );
    expect(vi.mocked(fetchStatementData).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses a customer in another company with the shared not-found text', async () => {
    vi.mocked(fetchStatementData).mockResolvedValue(null);
    const res = await customerStatementTool.handler(
      { customer_id: CUSTOMER, as_at: '2026-03-31' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Not found');
  });

  it('refuses a malformed customer_id and a malformed as_at before a cast', async () => {
    for (const args of [{ customer_id: 'abc', as_at: '2026-03-31' }, { customer_id: CUSTOMER, as_at: '2026-02-31' }]) {
      const res = await customerStatementTool.handler(args, ctx);
      expect(res.isError).toBe(true);
    }
    expect(fetchStatementData).not.toHaveBeenCalled();
  });

  it('serves no rows on a summary but keeps the totals', async () => {
    const env = json(await customerStatementTool.handler(
      { customer_id: CUSTOMER, as_at: '2026-03-31', detail: 'summary' }, ctx,
    ));
    expect(env.rows).toEqual([]);
    expect(env.summary.balance).toBe(6000);
    expect(env.completenessFault).toBeUndefined();
  });
});

describe('project_profitability — an empty list is the finding, not the answer', () => {
  it('reports the untagged P&L as a disclosure carrying its amount', async () => {
    const env = json(await projectProfitabilityTool.handler(
      { period_start: '2026-01-01', period_end: '2026-12-31' }, ctx,
    ));

    expect(env.rows).toEqual([]);
    // 100% untagged. Without this the response is `rows: []`, which reads as
    // "no projects were unprofitable".
    expect(env.project_tag_coverage.tagged_lines).toBe(0);
    expect(env.project_tag_coverage.untagged_lines).toBe(18752);
    expect(env.project_tag_coverage.untagged_amount).toBeCloseTo(9554153.53, 2);

    // NOT an exclusion. `rows` are projects; untagged journal lines were never
    // members of that universe, so they are disclosed outside the envelope
    // rather than counted inside its completeness identity — where one entry
    // would have stood for 18,752 lines and been counted as a single project.
    expect(env.excludedRows).toHaveLength(0);
    expect(env.universeTotal).toBeUndefined();
  });

  it('reports per-project revenue, cost and margin when lines ARE tagged', async () => {
    vi.mocked(getProjectProfitability).mockResolvedValue([{
      projectId: 'pr1', projectName: 'Lawley FTTH', periodStart: '2026-01-01', periodEnd: '2026-12-31',
      revenue: 500000, costs: 380000, profit: 120000, margin: 24,
      revenueLines: [], costLines: [],
    }]);
    vi.mocked(getProjectTaggingCoverage).mockResolvedValue({
      taggedLines: 40, untaggedLines: 0, untaggedAmount: 0, postedThrough: '2026-09-01T10:00:00.000Z',
    });
    const env = json(await projectProfitabilityTool.handler(
      { period_start: '2026-01-01', period_end: '2026-12-31' }, ctx,
    ));
    expect(env.rows[0].project_name).toBe('Lawley FTTH');
    expect(env.rows[0].margin_pct).toBe(24);
    expect(env.excludedRows).toEqual([]);
  });

  it('as_at is the END of the range, per the envelope contract', async () => {
    const env = json(await projectProfitabilityTool.handler(
      { period_start: '2026-01-01', period_end: '2026-12-31' }, ctx,
    ));
    expect(env.as_at).toBe('2026-12-31');
  });

  it('refuses a range whose end precedes its start', async () => {
    const res = await projectProfitabilityTool.handler(
      { period_start: '2026-12-31', period_end: '2026-01-01' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(getProjectProfitability).not.toHaveBeenCalled();
  });

  it('takes the company from the context, never from args', async () => {
    await projectProfitabilityTool.handler(
      { period_start: '2026-01-01', period_end: '2026-12-31', company_id: OTHER }, ctx,
    );
    expect(vi.mocked(getProjectProfitability).mock.calls[0]![0]).toBe(COMPANY);
  });
});

describe('wip_report', () => {
  it('totals hours and value per practice client', async () => {
    vi.mocked(getWipByClient).mockResolvedValue([{
      practiceClientId: 'pc1', legalName: 'Weszak Beleggings', linkCustomerId: null,
      totalHours: 12.5, totalValue: 10625, oldestApprovedDate: '2026-07-01', entries: [],
    }]);
    const env = json(await wipReportTool.handler({}, ctx));
    expect(env.rows[0].total_hours).toBe(12.5);
    expect(env.rows[0].total_value).toBe(10625);
    expect(env.rows[0].oldest_approved_date).toBe('2026-07-01');
  });

  it('says in its own description what it does NOT count', () => {
    // The report covers approved, unbilled, billable time only. Draft and
    // submitted hours are unbilled work too, and a reader who does not know
    // that will understate what the practice is owed.
    expect(wipReportTool.description).toMatch(/approved/i);
    expect(wipReportTool.description).toMatch(/draft/i);
  });

  it('takes the company from the context, never from args', async () => {
    await wipReportTool.handler({ company_id: OTHER }, ctx);
    expect(vi.mocked(getWipByClient).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses a malformed practice_client_id before a cast', async () => {
    const res = await wipReportTool.handler({ practice_client_id: 'abc' }, ctx);
    expect(res.isError).toBe(true);
    expect(getWipByClient).not.toHaveBeenCalled();
  });

  it('only returns the underlying time entries at detail: full', async () => {
    vi.mocked(getWipByClient).mockResolvedValue([{
      practiceClientId: 'pc1', legalName: 'Weszak Beleggings', linkCustomerId: null,
      totalHours: 2, totalValue: 1700, oldestApprovedDate: '2026-07-01',
      entries: [{ id: 'e1', hours: 2, lineTotal: 1700 }] as never,
    }]);
    expect(json(await wipReportTool.handler({}, ctx)).rows[0].entries).toBeUndefined();
    const full = json(await wipReportTool.handler({ detail: 'full' }, ctx));
    // Every aggregate must offer a route to the documents behind it.
    expect(full.rows[0].entries).toHaveLength(1);
  });
});

describe('job_cost_report — the statuses wip_report cannot show', () => {
  it('returns every status bucket, so submitted work is visible', async () => {
    const env = json(await jobCostReportTool.handler({}, ctx));
    const row = env.rows[0];
    expect(row.by_status.approved.value).toBe(1700);
    expect(row.by_status.submitted.value).toBe(85000);
    // wip_report would report 1,700 here and stop.
    expect(row.unbilled_value).toBe(86700);
  });

  it('is registered, mirrored and read-only', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain('job_cost_report');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('job_cost_report');
    expect(jobCostReportTool.write).toBe(false);
  });

  it('defaults to grouping by client and drops an out-of-range grouping', async () => {
    // The enum is advisory — nothing validates against it — and this value
    // chooses a SQL grouping branch.
    await jobCostReportTool.handler({ group_by: 'nonsense' }, ctx);
    expect(vi.mocked(getJobCostReport).mock.calls[0]![1].groupBy).toBe('client');
  });

  it('passes a valid grouping through', async () => {
    await jobCostReportTool.handler({ group_by: 'work_item' }, ctx);
    expect(vi.mocked(getJobCostReport).mock.calls[0]![1].groupBy).toBe('work_item');
  });

  it('carries the ungrouped exclusion and its value', async () => {
    const env = json(await jobCostReportTool.handler({}, ctx));
    expect(env.excludedRows[0].reason).toBe('no_client');
    expect(env.excludedRows[0].amount).toBe(1200);
    expect(env.completenessFault).toBeUndefined();
  });

  it('takes the company from the context, never from args', async () => {
    await jobCostReportTool.handler({ company_id: OTHER }, ctx);
    expect(vi.mocked(getJobCostReport).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses a malformed practice_client_id before a cast', async () => {
    const res = await jobCostReportTool.handler({ practice_client_id: 'abc' }, ctx);
    expect(res.isError).toBe(true);
    expect(getJobCostReport).not.toHaveBeenCalled();
  });
});
