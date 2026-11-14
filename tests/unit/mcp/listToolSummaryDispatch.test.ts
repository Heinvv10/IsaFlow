/**
 * `detail: "summary"` / `group_by` on the six large-result list tools, at the tool boundary.
 *
 *  1. DEFAULT PIN: with neither argument a tool calls its row service exactly as before (the full argument object is
 *     asserted), never touches the summary service, and answers the same keys.
 *  2. SAME FILTERS: the summary service receives the filters the row service gets, for the same arguments. A filter the
 *     tool maps for rows and forgets for the summary would total a bigger set than the rows it stands in for.
 *  3. Refusals: cursor/offset with a summary, an unknown group_by, group_by with row detail.
 *
 * The SQL itself (that the totals equal the rows) is proved against a real database in the *.int.test.ts suites.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GroupedSummary } from '@/modules/accounting/services/shared/groupedSummary';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({ getBankAccountsStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({ getBankTransactions: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTxSummaryService', () => ({
  BANK_TX_GROUP_BY: ['account', 'month', 'allocation'], summariseBankTransactions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ getSupplierInvoices: vi.fn(), getSupplierInvoiceById: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceSummaryService', () => ({
  SUPPLIER_INVOICE_GROUP_BY: ['supplier', 'status', 'month'], summariseSupplierInvoices: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceReadService', () => ({ listCustomerInvoices: vi.fn(), getCustomerInvoiceDetail: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({ getQuotes: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceSummaryService', () => ({
  CUSTOMER_INVOICE_GROUP_BY: ['customer', 'status', 'month'], summariseCustomerInvoices: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryListService', () => ({
  JOURNAL_LIST_STATUSES: ['draft', 'posted', 'reversed'], listJournalEntriesPage: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalSummaryService', () => ({
  JOURNAL_GROUP_BY: ['source', 'month', 'status'], summariseJournals: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/generalLedgerStreamService', () => ({ getGeneralLedgerLines: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/generalLedgerSummaryService', () => ({
  GENERAL_LEDGER_GROUP_BY: ['account', 'month', 'source', 'account_type'], summariseGeneralLedger: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/glLineExportService', () => ({
  getExportEntity: vi.fn(), fetchGlLineExportPage: vi.fn(), getGlLineExportSummary: vi.fn(), nextCursorOf: vi.fn(() => null),
}));
vi.mock('@/modules/accounting/services/reports/glLineExportSummaryService', () => ({
  GL_EXPORT_GROUP_BY: ['account', 'month', 'source', 'status'], summariseGlLineExport: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-10-09T08:00:00.000Z'),
}));

import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { summariseBankTransactions } from '@/modules/accounting/services/bank/bankTxSummaryService';
import { getSupplierInvoices } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { summariseSupplierInvoices } from '@/modules/accounting/services/ap/supplierInvoiceSummaryService';
import { listCustomerInvoices } from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { summariseCustomerInvoices } from '@/modules/accounting/services/ar/customerInvoiceSummaryService';
import { listJournalEntriesPage } from '@/modules/accounting/services/gl/journalEntryListService';
import { summariseJournals } from '@/modules/accounting/services/gl/journalSummaryService';
import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { summariseGeneralLedger } from '@/modules/accounting/services/gl/generalLedgerSummaryService';
import { fetchGlLineExportPage, getGlLineExportSummary, getExportEntity } from '@/modules/accounting/services/reports/glLineExportService';
import { summariseGlLineExport } from '@/modules/accounting/services/reports/glLineExportSummaryService';
import { listBankTransactionsTool } from '@/lib/mcp/tools/bank';
import { listSupplierInvoicesTool } from '@/lib/mcp/tools/supplierInvoices';
import { listInvoicesTool } from '@/lib/mcp/tools/invoices';
import { listJournalsTool } from '@/lib/mcp/tools/journals';
import { generalLedgerTool } from '@/lib/mcp/tools/generalLedger';
import { exportGlLinesTool } from '@/lib/mcp/tools/exportGlLines';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const CO = '22222222-2222-4222-8222-222222222222';
const ACC = '33333333-3333-4333-8333-333333333333';
const ctx: McpToolContext = {
  userId: 'u', companyId: CO, tokenJti: 'j', oauthAppId: null,
  scopes: ['read:bank-tx', 'read:invoices', 'read:reports'],
};
const SUMMARY: GroupedSummary = { totals: { count: 4 }, groups: [{ key: 'k', label: null, values: { count: 4 } }], groupsTotal: 1, other: null };
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

/** Everything a row call is given that a summary is not: paging, and how rows are shown. */
const unpaged = (o: unknown): Record<string, unknown> => {
  const { limit: _l, cursor: _c, offset: _o, after: _a, includeLines: _i, ...rest } = o as Record<string, unknown>;
  return rest;
};
const defined = (o: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(unpaged(o)).filter(([, v]) => v !== undefined));

interface Case {
  tool: McpTool;
  /** Arguments exercising every filter the tool has. */
  args: Record<string, unknown>;
  rows: ReturnType<typeof vi.fn>;
  summary: ReturnType<typeof vi.fn>;
  /** Index of the filter object in the row service's arguments, and in the summary service's. */
  rowArg: number;
  sumArg: number;
  group: string;
  /** The row service's arguments, EXACTLY, for `args` with no summary arguments. */
  expectedRowCall: unknown[];
  /** The tool's reply to a default call, EXACTLY. */
  expectedReply: unknown;
  rowResult: unknown;
}

const cases: Record<string, () => Case> = {
  list_bank_transactions: () => ({
    tool: listBankTransactionsTool,
    args: { bank_account_id: ACC, allocation_filter: 'allocated', from_date: '2026-01-01', to_date: '2026-03-31', description_contains: '50%' },
    rows: vi.mocked(getBankTransactions) as never, summary: vi.mocked(summariseBankTransactions) as never, rowArg: 1, sumArg: 1, group: 'allocation',
    rowResult: { transactions: [{ id: 't1' }], total: 1, nextCursor: undefined },
    expectedRowCall: [CO, {
      bankAccountId: ACC, allocationFilter: 'allocated', fromDate: '2026-01-01', toDate: '2026-03-31', limit: 50, cursor: undefined, search: '50\\%',
    }],
    expectedReply: { transactions: [{ id: 't1' }], total: 1, next_cursor: null },
  }),
  list_supplier_invoices: () => ({
    tool: listSupplierInvoicesTool,
    args: { status: 'approved', supplier_id: ACC, from_date: '2026-01-01', to_date: '2026-03-31', search: 'abc' },
    rows: vi.mocked(getSupplierInvoices) as never, summary: vi.mocked(summariseSupplierInvoices) as never, rowArg: 1, sumArg: 1, group: 'supplier',
    rowResult: { invoices: [], total: 0 },
    expectedRowCall: [CO, { status: 'approved', supplierId: ACC, fromDate: '2026-01-01', toDate: '2026-03-31', search: 'abc', limit: 50, offset: 0 }],
    expectedReply: { invoices: [], total: 0, offset: 0 },
  }),
  list_invoices: () => ({
    tool: listInvoicesTool,
    args: { status: 'sent', customer_id: ACC, search: 'abc' },
    rows: vi.mocked(listCustomerInvoices) as never, summary: vi.mocked(summariseCustomerInvoices) as never, rowArg: 1, sumArg: 1, group: 'customer',
    rowResult: { invoices: [], total: 0 },
    expectedRowCall: [CO, { status: ['sent'], clientId: ACC, search: 'abc', limit: 25, offset: 0 }],
    expectedReply: { invoices: [], total: 0, next_offset: null },
  }),
  list_journals: () => ({
    tool: listJournalsTool,
    args: { from_date: '2026-01-01', to_date: '2026-03-31', status: 'posted', source: 'manual', account_id: ACC },
    rows: vi.mocked(listJournalEntriesPage) as never, summary: vi.mocked(summariseJournals) as never, rowArg: 1, sumArg: 1, group: 'source',
    rowResult: { entries: [], nextCursor: null },
    expectedRowCall: [CO, {
      fromDate: '2026-01-01', toDate: '2026-03-31', status: 'posted', source: 'manual', accountId: ACC, includeLines: false, limit: 50, cursor: undefined,
    }],
    expectedReply: { journals: [], next_cursor: null },
  }),
  general_ledger: () => ({
    tool: generalLedgerTool,
    args: { period_start: '2026-01-01', period_end: '2026-03-31', account_codes: ['1000'], account_types: ['asset'], sources: ['manual'], min_amount: 5, search: 'rent' },
    rows: vi.mocked(getGeneralLedgerLines) as never, summary: vi.mocked(summariseGeneralLedger) as never, rowArg: 0, sumArg: 0, group: 'account',
    rowResult: {
      lines: [], next: null, lineCount: 0, universeLineCount: 0, totalDebit: 0, totalCredit: 0, accountCount: 0, balanced: null,
      runningBalanceSuppressed: true, incomeStatementBalanceNullFrom: null, openingBalances: {}, postedThrough: null,
    },
    expectedRowCall: [{
      companyId: CO, periodStart: '2026-01-01', periodEnd: '2026-03-31', accountCodes: ['1000'], accountIds: undefined, accountTypes: ['asset'],
      sources: ['manual'], minAmount: 5, search: 'rent', limit: 200, after: null,
    }],
    expectedReply: null,
  }),
  export_gl_lines: () => ({
    tool: exportGlLinesTool,
    args: { date_from: '2026-01-01', date_to: '2026-03-31', status: 'posted' },
    rows: vi.mocked(fetchGlLineExportPage) as never, summary: vi.mocked(summariseGlLineExport) as never, rowArg: 1, sumArg: 1, group: 'month',
    rowResult: [],
    expectedRowCall: [CO, { dateFrom: '2026-01-01', dateTo: '2026-03-31', status: 'posted' }, null, 100],
    expectedReply: null,
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(summariseBankTransactions).mockResolvedValue(SUMMARY);
  vi.mocked(summariseSupplierInvoices).mockResolvedValue(SUMMARY);
  vi.mocked(summariseCustomerInvoices).mockResolvedValue(SUMMARY);
  vi.mocked(summariseJournals).mockResolvedValue(SUMMARY);
  vi.mocked(summariseGeneralLedger).mockResolvedValue(SUMMARY);
  vi.mocked(summariseGlLineExport).mockResolvedValue(SUMMARY);
  vi.mocked(getGlLineExportSummary).mockResolvedValue({ rowCount: 0, lastTxnDate: null } as never);
  vi.mocked(getExportEntity).mockResolvedValue({} as never);
});

describe.each(Object.keys(cases))('%s', (name) => {
  const c = (): Case => cases[name]!();
  const arm = (k: Case): void => { k.rows.mockResolvedValue(k.rowResult); };

  it('DEFAULT PIN: no summary arguments -> the row service gets exactly the old arguments, the summary service is untouched', async () => {
    const k = c(); arm(k);
    const res = await k.tool.handler(k.args, ctx);
    expect(res.isError).toBeUndefined();
    expect(k.rows).toHaveBeenCalledTimes(1);
    expect(k.rows.mock.calls[0]).toEqual(k.expectedRowCall);
    expect(k.summary).not.toHaveBeenCalled();
    if (k.expectedReply !== null) expect(parse(res)).toEqual(k.expectedReply);
    // Not even a hint of the new mode in a default reply.
    expect(res.content[0]!.text).not.toMatch(/"group_by"|"groups"|"totals"/);
  });

  it('SAME FILTERS: detail summary hands the summary service the filters the row service gets', async () => {
    const k = c(); arm(k);
    await k.tool.handler(k.args, ctx);
    const rowFilters = defined(k.rows.mock.calls[0]![k.rowArg]);
    vi.clearAllMocks(); arm(k);
    vi.mocked(getGlLineExportSummary).mockResolvedValue({ rowCount: 0, lastTxnDate: null } as never);
    vi.mocked(getExportEntity).mockResolvedValue({} as never);
    k.summary.mockResolvedValue(SUMMARY);
    const res = await k.tool.handler({ ...k.args, detail: 'summary', group_by: k.group }, ctx);
    expect(res.isError, res.content[0]!.text).toBeUndefined();
    expect(k.summary).toHaveBeenCalledTimes(1);
    expect(defined(k.summary.mock.calls[0]![k.sumArg])).toEqual(rowFilters);
    expect(k.summary.mock.calls[0]![k.summary.mock.calls[0]!.length - 1]).toBe(k.group);
  });

  it('group_by answers groups that come from the summary service', async () => {
    const k = c(); arm(k);
    k.summary.mockResolvedValue(SUMMARY);
    const body = parse(await k.tool.handler({ ...k.args, group_by: k.group }, ctx));
    expect(body.detail).toBe('summary');
    expect(body.group_by).toBe(k.group);
    expect(body.groups).toEqual([{ key: 'k', label: null, count: 4 }]);
    expect(body.groups_total).toBe(1);
  });

  it('refuses a cursor, an unknown group_by, and group_by with row detail; none of them reaches a service', async () => {
    const k = c(); arm(k);
    for (const bad of [
      { detail: 'summary', cursor: 'x' }, { group_by: 'planet' }, { group_by: k.group, detail: 'standard' },
    ]) {
      const res = await k.tool.handler({ ...k.args, ...bad }, ctx);
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(k.summary).not.toHaveBeenCalled();
    expect(k.rows).not.toHaveBeenCalled();
  });

  it('declares detail and group_by in its schema', () => {
    const props = c().tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.group_by?.enum).toContain(c().group);
    expect(props.detail?.enum).toContain('summary');
  });
});

describe('tools that already had detail keep reading it as before', () => {
  it('general_ledger: detail summary without group_by is the old summary, with no groups and no summary-service call', async () => {
    const k = cases.general_ledger!();
    k.rows.mockResolvedValue(k.rowResult);
    const body = parse(await k.tool.handler({ ...k.args, detail: 'summary' }, ctx));
    expect(vi.mocked(summariseGeneralLedger)).not.toHaveBeenCalled();
    expect(k.rows.mock.calls[0]![0]).toMatchObject({ limit: 1 });
    expect(body).not.toHaveProperty('groups');
    expect(body.detail).toBe('summary');
  });

  it('general_ledger / export_gl_lines: an unknown detail still falls back to rows', async () => {
    const gl = cases.general_ledger!();
    gl.rows.mockResolvedValue(gl.rowResult);
    expect((await gl.tool.handler({ ...gl.args, detail: 'bogus' }, ctx)).isError).toBeUndefined();
    expect(gl.rows.mock.calls[0]![0]).toMatchObject({ limit: 200 });
  });

  it('export_gl_lines: group_by is for table lines only', async () => {
    const res = await exportGlLinesTool.handler({ table: 'accounts', group_by: 'month' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('table "lines" only');
  });
});
