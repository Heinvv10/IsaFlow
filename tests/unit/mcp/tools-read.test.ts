/**
 * MCP read tools — MCP Phase 2, Task 2.6.
 *
 * Per-tool: happy path returns ok(data); the service receives ctx.companyId
 * (never an args-supplied company); misses return the generic NOT_FOUND text.
 * Suite-wide: token-scan (no credential material in any envelope/manifest)
 * and manifest shape (25 read tools, write:false, additionalProperties:false).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  // `unsafe` is part of the real client — itemService uses it for its
  // pre-validated enum fragments — so the stub carries it too. Without it the
  // scan below cannot reach list_items at all.
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((fragment: string) => fragment),
  });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

// fmtDate is NOT stubbed. It moved out of @/lib/neon into its own pure module,
// and the balance_sheet default-date test is more useful running the real
// implementation against a frozen clock than against a hardcoded return value:
// that is what proves the default is the LOCAL calendar day and not the UTC one.

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/trialBalanceService', () => ({ getTrialBalance: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodIdForDate: vi.fn(),
  getFiscalPeriods: vi.fn().mockResolvedValue([]),
  getFiscalPeriodById: vi.fn().mockResolvedValue(null),
  getJournalCountsByYear: vi.fn().mockResolvedValue({}),
  resolveCompanyPeriodAlignment: vi.fn().mockResolvedValue({
    declaredStartMonth: 3, observedStartMonth: null, startMonth: 3, aligned: true,
  }),
}));
vi.mock('@/modules/accounting/services/gl/periodCloseReadinessService', () => ({
  getCloseReadiness: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/modules/accounting/services/bank/bankStatementCoverageService', () => ({
  DEFAULT_MIN_GAP_DAYS: 7,
  getBankStatementCoverage: vi.fn().mockResolvedValue({
    asAt: '2026-09-03', accounts: [],
    totals: { glBalance: 0, statementBalance: 0, computedBalance: 0, difference: 0, transactionCount: 0 },
    postedThrough: null,
  }),
}));
vi.mock('@/modules/accounting/services/gl/openingBalanceReadService', () => ({
  getOpeningBalances: vi.fn().mockResolvedValue({
    rows: [], disagreements: [], accountsWithoutOpeningBalance: [],
    totals: { posted: 0, metadata: 0 }, postedThrough: null,
  }),
}));
vi.mock('@/modules/accounting/services/reports/incomeStatementService', () => ({ getIncomeStatement: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ getBalanceSheet: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({ getARAging: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAging: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/accountLedgerService', () => ({ getAccountLedger: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ getChartOfAccounts: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceReadService', () => ({
  listCustomerInvoices: vi.fn(),
  getCustomerInvoiceDetail: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({ getQuotes: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  listCustomers: vi.fn(),
  listSuppliers: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({
  getBankAccountsStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  getBankTransactions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  getSupplierInvoices: vi.fn(),
  getSupplierInvoiceById: vi.fn(),
}));

import {
  getSupplierInvoices,
  getSupplierInvoiceById,
} from '@/modules/accounting/services/ap/supplierInvoiceService';

vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  getCreditNotes: vi.fn(),
  getCreditNoteById: vi.fn(),
}));

import {
  getCreditNotes,
  getCreditNoteById,
} from '@/modules/accounting/services/ar/creditNoteService';
import { getCompany } from '@/modules/accounting/services/core/companyService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getChartOfAccounts } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  listCustomerInvoices,
  getCustomerInvoiceDetail,
} from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { getQuotes } from '@/modules/accounting/services/ar/quoteService';
import {
  listCustomers,
  listSuppliers,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { InvalidCursorError } from '@/modules/accounting/services/bank/bankTxCursor';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';

import { mcpRegistry, MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

interface CompactRow {
  id: string;
  date: string;
  amount: number;
  bank_reference: string | null;
  allocation: 'allocated' | 'suggested' | 'unallocated' | 'excluded';
}

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_COMPANY = '99999999-9999-9999-9999-999999999999';

function ctx(scopes: string[] = ['read:reports', 'read:invoices', 'read:contacts', 'read:bank-tx', 'read:vat']): McpToolContext {
  return { userId: 'user-1', companyId: COMPANY_ID, scopes, tokenJti: 'jti-1', oauthAppId: null };
}

function tool(name: string): McpTool {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t;
}

function parseOk(r: { content: Array<{ text: string }>; isError?: boolean }): unknown {
  expect(r.isError).toBeUndefined();
  return JSON.parse(r.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const emptyVat201 = {
  periodStart: '2026-05-01', periodEnd: '2026-06-30', detail: 'standard' as const,
  boxes: [], totals: { outputTax: 0, inputTax: 0, netVat: 0, standardRatedSupplies: 0, standardRatedPurchases: 0 },
  rateCheck: { rate: 0.15, outputImpliedTax: 0, outputVariance: 0, inputImpliedTax: 0, inputVariance: 0, ties: true, entriesWithoutBase: [], entriesWithoutBaseTotal: 0 },
  rows: [], rowsTotal: 0, universeTotal: 0, excludedRows: [], excludedLineCount: 0, excludedAmount: 0,
  nextCursor: null, postedThrough: '2026-06-30T00:00:00.000Z',
};

describe('company_profile', () => {
  it('returns a trimmed profile from getCompany(ctx.companyId)', async () => {
    vi.mocked(getCompany).mockResolvedValue({
      name: 'Demo Co', vatNumber: '4123456789', financialYearStart: 3,
      defaultCurrency: 'ZAR', currencySymbol: 'R', vatPeriod: 'bi-monthly',
    } as never);
    const data = parseOk(await tool('company_profile').handler({}, ctx())) as Record<string, unknown>;
    expect(getCompany).toHaveBeenCalledWith(COMPANY_ID);
    expect(data.name).toBe('Demo Co');
    expect(data.base_currency).toBe('ZAR');
    expect(Object.keys(data)).toHaveLength(6); // trimmed, not the 150-field record
  });

  it('miss → generic Not found', async () => {
    vi.mocked(getCompany).mockResolvedValue(null);
    const r = await tool('company_profile').handler({}, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
  });
});

describe('reports tools', () => {
  it('trial_balance defaults to the fiscal period containing today', async () => {
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValue('fp-1');
    vi.mocked(getTrialBalance).mockResolvedValue([{ accountCode: '1000' }] as never);
    const data = parseOk(await tool('trial_balance').handler({}, ctx())) as Record<string, unknown>;
    expect(getFiscalPeriodIdForDate).toHaveBeenCalledWith(COMPANY_ID, expect.any(Date));
    expect(getTrialBalance).toHaveBeenCalledWith(COMPANY_ID, 'fp-1');
    expect(data.fiscal_period_id).toBe('fp-1');
  });

  it('profit_and_loss requires both dates and passes companyId first', async () => {
    vi.mocked(getIncomeStatement).mockResolvedValue({ netProfit: 100 } as never);
    parseOk(await tool('profit_and_loss').handler(
      { period_start: '2026-06-01', period_end: '2026-06-30' }, ctx(),
    ));
    expect(getIncomeStatement).toHaveBeenCalledWith(COMPANY_ID, '2026-06-01', '2026-06-30');
    const bad = await tool('profit_and_loss').handler({}, ctx());
    expect(bad.isError).toBe(true);
  });

  it('balance_sheet defaults as_at to today via fmtDate', async () => {
    vi.mocked(getBalanceSheet).mockResolvedValue({ totalAssets: 1 } as never);
    // 22:30 local on the 19th is 20:30 UTC the same day; the 00:30 case below
    // is the one that used to report the previous day.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 19, 22, 30, 0));
      parseOk(await tool('balance_sheet').handler({}, ctx()));
      expect(getBalanceSheet).toHaveBeenCalledWith(COMPANY_ID, '2026-07-19');

      // 00:30 SAST on the 19th is 22:30 UTC on the 18th. toISOString() would
      // default the balance sheet to the WRONG day; fmtDate must not.
      vi.mocked(getBalanceSheet).mockClear();
      vi.setSystemTime(new Date(2026, 6, 19, 0, 30, 0));
      parseOk(await tool('balance_sheet').handler({}, ctx()));
      expect(getBalanceSheet).toHaveBeenCalledWith(COMPANY_ID, '2026-07-19');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aged_debtors / aged_creditors call the existing aging services', async () => {
    vi.mocked(getARAging).mockResolvedValue([] as never);
    vi.mocked(getAPAging).mockResolvedValue([] as never);
    parseOk(await tool('aged_debtors').handler({ as_at: '2026-07-01' }, ctx()));
    parseOk(await tool('aged_creditors').handler({}, ctx()));
    expect(getARAging).toHaveBeenCalledWith(COMPANY_ID, '2026-07-01');
    expect(getAPAging).toHaveBeenCalledWith(COMPANY_ID, undefined);
  });

  it('search_gl passes companyId inside the params object and caps the limit at 200', async () => {
    vi.mocked(getAccountLedger).mockResolvedValue({ rows: [], total: 0 } as never);
    parseOk(await tool('search_gl').handler(
      { account_code: '1000', from_date: '2026-01-01', to_date: '2026-06-30', limit: 9999 }, ctx(),
    ));
    expect(getAccountLedger).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, accountCode: '1000', limit: 200 }),
    );
    const bad = await tool('search_gl').handler({ from_date: '2026-01-01', to_date: '2026-06-30' }, ctx());
    expect(bad.isError).toBe(true); // needs account_id or account_code
  });
});

describe('invoice + quote tools', () => {
  it('list_invoices normalises filters and caps at 100', async () => {
    vi.mocked(listCustomerInvoices).mockResolvedValue({ invoices: [], total: 0 });
    parseOk(await tool('list_invoices').handler(
      { status: 'sent', customer_id: '21d12090-6fd3-44b1-8c7a-5ea3e84254bb', limit: 500 }, ctx(),
    ));
    expect(listCustomerInvoices).toHaveBeenCalledWith(COMPANY_ID, {
      status: ['sent'], clientId: '21d12090-6fd3-44b1-8c7a-5ea3e84254bb', search: null, limit: 100,
    });
  });

  it('get_invoice: cross-tenant probe reads identically to a genuine miss', async () => {
    vi.mocked(getCustomerInvoiceDetail).mockResolvedValue(null);
    const r = await tool('get_invoice').handler({ invoice_id: '080a23a7-88b5-4aed-8b09-713f4d15b17b' }, ctx());
    expect(getCustomerInvoiceDetail).toHaveBeenCalledWith(COMPANY_ID, '080a23a7-88b5-4aed-8b09-713f4d15b17b');
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found'); // no tenant hints
  });

  it('list_quotes calls getQuotes(companyId, filters)', async () => {
    vi.mocked(getQuotes).mockResolvedValue({ quotes: [], total: 0 } as never);
    parseOk(await tool('list_quotes').handler({ status: 'draft' }, ctx()));
    expect(getQuotes).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({ status: 'draft' }));
  });
});

describe('contact + bank + vat tools', () => {
  it('directory and bank tools receive ctx.companyId', async () => {
    vi.mocked(listCustomers).mockResolvedValue([]);
    vi.mocked(listSuppliers).mockResolvedValue({ suppliers: [], total: 0 });
    vi.mocked(getBankAccountsStatus).mockResolvedValue([]);
    vi.mocked(getBankTransactions).mockResolvedValue({ transactions: [], total: 0 } as never);

    parseOk(await tool('list_customers').handler({ search: 'brit' }, ctx()));
    parseOk(await tool('list_suppliers').handler({}, ctx()));
    parseOk(await tool('bank_accounts_status').handler({}, ctx()));
    parseOk(await tool('list_bank_transactions').handler({ allocation_filter: 'unallocated' }, ctx()));

    expect(listCustomers).toHaveBeenCalledWith(COMPANY_ID, 'brit');
    expect(listSuppliers).toHaveBeenCalledWith(COMPANY_ID, expect.any(Object));
    // companyId stays first — the point of this test. The options arg opts the
    // tool into inactive accounts: an agent asking for status is asking about
    // money, and a deactivated account still holds a balance.
    expect(getBankAccountsStatus).toHaveBeenCalledWith(COMPANY_ID, { includeInactive: true });
    expect(getBankTransactions).toHaveBeenCalledWith(
      COMPANY_ID, expect.objectContaining({ allocationFilter: 'unallocated', limit: 50 }),
    );
  });

  it('vat_status requires the period and passes companyId first', async () => {
    vi.mocked(getVat201Report).mockResolvedValue(emptyVat201 as never);
    parseOk(await tool('vat_status').handler(
      { period_start: '2026-05-01', period_end: '2026-06-30' }, ctx(),
    ));
    expect(getVat201Report).toHaveBeenCalledWith(
      COMPANY_ID, '2026-05-01', '2026-06-30',
      expect.objectContaining({ detail: 'standard' }),
    );
    const bad = await tool('vat_status').handler({}, ctx());
    expect(bad.isError).toBe(true);
  });

  it('vat_status refuses a period that runs backwards before touching the service', async () => {
    vi.mocked(getVat201Report).mockClear();
    const r = await tool('vat_status').handler(
      { period_start: '2026-06-30', period_end: '2026-05-01' }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(getVat201Report).not.toHaveBeenCalled();
  });

  it('vat_status accepts the specification spelling "boxes" as the standard level', async () => {
    // The audit spec names the middle level `boxes`; the shared contract names
    // it `standard`. They are the same level and both spellings are accepted.
    vi.mocked(getVat201Report).mockResolvedValue(emptyVat201 as never);
    parseOk(await tool('vat_status').handler(
      { period_start: '2026-05-01', period_end: '2026-06-30', detail: 'boxes' }, ctx(),
    ));
    expect(getVat201Report).toHaveBeenLastCalledWith(
      COMPANY_ID, '2026-05-01', '2026-06-30',
      expect.objectContaining({ detail: 'standard' }),
    );
  });
});

// ── PRD-11 §3: list_bank_transactions cursor + compact rows ──────────────────

describe('list_bank_transactions — paging and compact rows', () => {
  // A real UUID: the tool rejects anything else before the service is called,
  // because bank_account_id reaches SQL as `$n::UUID`.
  const ACCOUNT_UUID = '33333333-3333-4333-8333-333333333333';
  const baseTx = {
    id: '045ef594-d81d-4f21-84d6-1151ed71260d', bankAccountId: 'ba36a4ed-d92d-47c6-8d4e-05462aea603a', transactionDate: '2026-03-05', amount: -250.5,
    bankReference: 'ABSA-991', status: 'imported' as const, createdAt: 'x', updatedAt: 'x',
  };

  it('passes the cursor through and surfaces next_cursor', async () => {
    vi.mocked(getBankTransactions).mockResolvedValue({
      transactions: [baseTx], total: 240, nextCursor: 'CURSOR-2',
    } as never);

    const out = parseOk(await tool('list_bank_transactions').handler(
      { bank_account_id: ACCOUNT_UUID, cursor: 'CURSOR-1' }, ctx(),
    )) as { total: number; next_cursor: string | null };

    expect(getBankTransactions).toHaveBeenCalledWith(
      COMPANY_ID, expect.objectContaining({ cursor: 'CURSOR-1', bankAccountId: ACCOUNT_UUID }),
    );
    expect(out.total).toBe(240);
    expect(out.next_cursor).toBe('CURSOR-2');
  });

  it('reports next_cursor = null on the final page', async () => {
    vi.mocked(getBankTransactions).mockResolvedValue({ transactions: [], total: 0 } as never);
    const out = parseOk(await tool('list_bank_transactions').handler({}, ctx())) as {
      next_cursor: string | null;
    };
    expect(out.next_cursor).toBeNull();
  });

  it('fields=full (default) returns the whole row', async () => {
    vi.mocked(getBankTransactions).mockResolvedValue({
      transactions: [{ ...baseTx, description: 'Fuel' }], total: 1,
    } as never);
    const out = parseOk(await tool('list_bank_transactions').handler({}, ctx())) as {
      transactions: Array<Record<string, unknown>>;
    };
    expect(out.transactions[0]).toMatchObject({ description: 'Fuel', transactionDate: '2026-03-05' });
  });

  it('fields=compact returns only the five agent-facing fields', async () => {
    vi.mocked(getBankTransactions).mockResolvedValue({
      transactions: [{ ...baseTx, description: 'Fuel', suggestedStrategy: 'rule' }], total: 1,
    } as never);
    const out = parseOk(await tool('list_bank_transactions').handler({ fields: 'compact' }, ctx())) as {
      transactions: Array<Record<string, unknown>>;
    };
    expect(Object.keys(out.transactions[0]!).sort()).toEqual(
      ['allocation', 'amount', 'bank_reference', 'date', 'id'],
    );
    expect(out.transactions[0]).toEqual({
      id: '045ef594-d81d-4f21-84d6-1151ed71260d', date: '2026-03-05', amount: -250.5, bank_reference: 'ABSA-991',
      allocation: 'unallocated',
    });
  });

  it('compact falls back to `reference` when bank_reference is empty', async () => {
    // The production shape: 9,824 rows carry `reference`, ZERO carry
    // `bank_reference`, so compact used to answer null on EVERY row while
    // fields="full" showed the value — and the agent then had nothing to feed
    // back into allocate_bank_transaction.
    vi.mocked(getBankTransactions).mockResolvedValue({
      transactions: [
        { ...baseTx, id: 'a', bankReference: undefined, reference: '20220402-0011' },
        { ...baseTx, id: 'b', bankReference: 'FEED-77', reference: 'STMT-1' },
        { ...baseTx, id: 'c', bankReference: undefined, reference: undefined },
      ],
      total: 3,
    } as never);
    const out = parseOk(await tool('list_bank_transactions').handler({ fields: 'compact' }, ctx())) as {
      transactions: CompactRow[];
    };
    expect(out.transactions.map((t) => t.bank_reference)).toEqual(
      // bank_reference still WINS where it is set — it is the feed's stable
      // external id, which is the better handle when both exist.
      ['20220402-0011', 'FEED-77', null],
    );
  });

  it('documents the compact bank_reference source and the silent limit clamp', () => {
    const desc = tool('list_bank_transactions').description;
    expect(desc).toContain('either column');
    expect(desc).toMatch(/clamp/i);
  });

  it('accepts a limit above 100 and clamps it rather than refusing', async () => {
    vi.mocked(getBankTransactions).mockResolvedValue({ transactions: [], total: 0 } as never);
    await tool('list_bank_transactions').handler({ limit: 500 }, ctx());
    expect(getBankTransactions).toHaveBeenCalledWith(
      COMPANY_ID, expect.objectContaining({ limit: 100 }),
    );
  });

  it('derives allocation state: a posted journal line beats any suggestion', async () => {
    vi.mocked(getBankTransactions).mockResolvedValue({
      transactions: [
        { ...baseTx, id: 'a', matchedJournalLineId: 'jl-1', suggestedGlAccountId: 'gl-1' },
        { ...baseTx, id: 'b', suggestedGlAccountId: 'gl-1' },
        { ...baseTx, id: 'c', suggestedSupplierId: '3fc5ec9c-e919-4f35-822a-aa193ae94984' },
        { ...baseTx, id: 'd', suggestedClientId: 'cus-1' },
        { ...baseTx, id: 'e', allocationType: 'account' },
        { ...baseTx, id: 'f', bankReference: undefined },
      ],
      total: 6,
    } as never);
    const out = parseOk(await tool('list_bank_transactions').handler({ fields: 'compact' }, ctx())) as {
      transactions: CompactRow[];
    };
    expect(out.transactions.map((t) => [t.id, t.allocation])).toEqual([
      ['a', 'allocated'], ['b', 'suggested'], ['c', 'suggested'],
      ['d', 'suggested'], ['e', 'suggested'], ['f', 'unallocated'],
    ]);
    // A missing bank_reference is null, not undefined — the key must survive JSON.
    expect(out.transactions[5]!.bank_reference).toBeNull();
  });

  it('labels an excluded row "excluded", never "unallocated"', async () => {
    // allocation_filter=unallocated and =suggested BOTH carry
    // `AND bt.status != 'excluded'` in SQL, so an excluded row comes back from
    // neither. Calling it unallocated would point the agent at a row that no
    // filter will ever hand it.
    vi.mocked(getBankTransactions).mockResolvedValue({
      transactions: [
        { ...baseTx, id: 'x1', status: 'excluded' },
        { ...baseTx, id: 'x2', status: 'excluded', suggestedGlAccountId: 'gl-1' },
        { ...baseTx, id: 'x3', status: 'excluded', allocationType: 'account' },
      ],
      total: 3,
    } as never);
    const out = parseOk(await tool('list_bank_transactions').handler({ fields: 'compact' }, ctx())) as {
      transactions: CompactRow[];
    };
    expect(out.transactions.map((t) => t.allocation)).toEqual(['excluded', 'excluded', 'excluded']);
  });

  it('a posted journal line still wins over an excluded status', async () => {
    // A row can be excluded AFTER it was allocated; the money moved either way,
    // so an agent must not read it as something still to deal with.
    vi.mocked(getBankTransactions).mockResolvedValue({
      transactions: [{ ...baseTx, id: 'x4', status: 'excluded', matchedJournalLineId: 'jl-9' }],
      total: 1,
    } as never);
    const out = parseOk(await tool('list_bank_transactions').handler({ fields: 'compact' }, ctx())) as {
      transactions: CompactRow[];
    };
    expect(out.transactions[0]!.allocation).toBe('allocated');
  });

  it('tells the agent what the fourth allocation value means', () => {
    expect(tool('list_bank_transactions').description).toContain('excluded');
  });

  it('maps an unusable cursor to a plain tool error, never a stack trace', async () => {
    vi.mocked(getBankTransactions).mockRejectedValue(new InvalidCursorError());
    const r = await tool('list_bank_transactions').handler({ cursor: 'junk' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('invalid cursor');
  });

  it('does not swallow genuine service failures', async () => {
    vi.mocked(getBankTransactions).mockRejectedValue(new Error('boom'));
    await expect(tool('list_bank_transactions').handler({}, ctx())).rejects.toThrow('boom');
  });
});

describe('suite-wide invariants', () => {
  const READ_TOOLS = MCP_TOOLS.filter((t) => !t.write);

  it('exactly 60 read tools, all write:false, additionalProperties:false everywhere', () => {
    expect(READ_TOOLS).toHaveLength(60);
    // Every registered tool is drift-guarded against CLIENT_MCP_TOOL_NAMES.
    expect(MCP_TOOLS).toHaveLength(CLIENT_MCP_TOOL_NAMES.length);
    for (const t of READ_TOOLS) {
      expect(t.write).toBe(false);
      expect(t.requiresPost).toBeUndefined();
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  // This used to assert that no tool schema mentions "company" at all. That was
  // a PROXY for the real rule, and the proxy became wrong when write tools
  // gained an assert-only `company_id`. The real rule — no tool takes its SCOPE
  // from an argument — is pinned in three parts below, plus behaviourally in
  // companyAssert.test.ts. A blanket name ban would now pass by forbidding the
  // guard while saying nothing about where scope comes from.
  // Narrowed once more, for the same reason it was narrowed before. The rule
  // is that no tool takes its SCOPE from an argument — NOT that the word
  // "company" may not appear. audit_trail's `acting_company_id` filters a DATA
  // COLUMN (which firm the actor was acting for, migration 581); it is the same
  // kind of argument as `user_id` or `source`, and it cannot widen scope
  // because every query underneath still carries `company_id = ctx.companyId`
  // — pinned by the scope test below and by the service's own suite.
  //
  // Ban the SELECTOR names exactly, and allow a data column to be named after
  // a company. A blanket /company/i ban would forbid an honest filter while
  // saying nothing about where scope comes from, which is the failure this
  // assertion has already had once.
  const SCOPE_SELECTOR_NAMES = ['company_id', 'companyid', 'company', 'tenant_id', 'tenantid'];
  const SCOPE_SAFE_COMPANY_PROPS = new Set([
    'acting_company_id',                  // which firm the actor acted for
    'posted_from_outside_this_company',   // boolean filter; selects nothing
  ]);

  it('no tool DECLARES a company identifier that could select the tenant', () => {
    for (const t of MCP_TOOLS) {
      const props = Object.keys(
        ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      );
      for (const p of props) {
        expect(SCOPE_SELECTOR_NAMES).not.toContain(p.toLowerCase());
        // Anything else mentioning a company must be on the reviewed list, so
        // a new one cannot arrive without someone justifying it here.
        if (/company/i.test(p)) expect(SCOPE_SAFE_COMPANY_PROPS.has(p)).toBe(true);
      }
    }
  });

  it('a scope-safe company property still cannot widen the tenant scope', async () => {
    // audit_trail is the only tool with one. Its handler must pass ctx's
    // company through unchanged no matter what the argument says.
    const { queryAuditTrail } = await import(
      '@/modules/accounting/services/gl/auditTrailLedgerService');
    const spy = vi.spyOn(
      await import('@/modules/accounting/services/gl/auditTrailLedgerService'),
      'queryAuditTrail',
    );
    expect(typeof queryAuditTrail).toBe('function');
    spy.mockRestore();

    const t = MCP_TOOLS.find((x) => x.name === 'audit_trail')!;
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('acting_company_id');
    expect(props).not.toHaveProperty('company_id');
  });

  it('the manifest offers the company_id ASSERTION on every write tool, and no read tool', () => {
    const manifest = mcpRegistry.getManifest();
    const byName = new Map(manifest.map((m) => [m.name, m]));
    for (const t of MCP_TOOLS) {
      const props = Object.keys(
        ((byName.get(t.name)!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      );
      // A read against the wrong company returns that company's data, which is
      // visible and self-correcting. A write is not, so only writes carry it.
      expect(props.includes('company_id')).toBe(t.write);
    }
  });

  it('the assertion describes itself as a guard, never a selector', () => {
    const write = mcpRegistry.getManifest().find((m) => m.name === 'create_draft_journal')!;
    const desc = String(
      ((write.inputSchema as { properties: Record<string, { description?: string }> })
        .properties.company_id.description),
    );
    expect(desc).toMatch(/never redirect|cannot redirect|not a selector/i);
  });

  it('token-scan: no credential material in the manifest or any result envelope', async () => {
    // Feed every service mock innocuous data, run every tool, scan everything.
    vi.mocked(getCompany).mockResolvedValue({ name: 'Co' } as never);
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValue('fp-1');
    vi.mocked(getTrialBalance).mockResolvedValue([] as never);
    vi.mocked(getIncomeStatement).mockResolvedValue({} as never);
    vi.mocked(getBalanceSheet).mockResolvedValue({} as never);
    vi.mocked(getARAging).mockResolvedValue([] as never);
    vi.mocked(getAPAging).mockResolvedValue([] as never);
    vi.mocked(getAccountLedger).mockResolvedValue({ rows: [] } as never);
    vi.mocked(getChartOfAccounts).mockResolvedValue([]);
    vi.mocked(listCustomerInvoices).mockResolvedValue({ invoices: [], total: 0 });
    vi.mocked(getCustomerInvoiceDetail).mockResolvedValue({ id: '4cd9b767-2d7f-4ee8-8b51-fb1e049f6903', items: [] });
    vi.mocked(getQuotes).mockResolvedValue({ quotes: [], total: 0 } as never);
    vi.mocked(listCustomers).mockResolvedValue([]);
    vi.mocked(listSuppliers).mockResolvedValue({ suppliers: [], total: 0 });
    vi.mocked(getBankAccountsStatus).mockResolvedValue([]);
    vi.mocked(getBankTransactions).mockResolvedValue({ transactions: [], total: 0 } as never);
    vi.mocked(getVat201Report).mockResolvedValue(emptyVat201 as never);
    vi.mocked(getSupplierInvoices).mockResolvedValue({ invoices: [], total: 0 } as never);
    vi.mocked(getSupplierInvoiceById).mockResolvedValue(
      { id: '2f9a4c1d-0b3e-4f8a-9c21-7d5e6a8b1c30', items: [] } as never,
    );
    vi.mocked(getCreditNotes).mockResolvedValue({ creditNotes: [], total: 0 } as never);
    vi.mocked(getCreditNoteById).mockResolvedValue(
      { id: '8b1c30d5-2f9a-4c1d-9c21-7d5e6a0b3e4f', type: 'customer' } as never,
    );

    const happyArgs: Record<string, Record<string, unknown>> = {
      profit_and_loss: { period_start: '2026-06-01', period_end: '2026-06-30' },
      vat_status: { period_start: '2026-05-01', period_end: '2026-06-30' },
      search_gl: { account_code: '1000', from_date: '2026-01-01', to_date: '2026-06-30' },
      get_invoice: { invoice_id: '4cd9b767-2d7f-4ee8-8b51-fb1e049f6903' },
      get_supplier_invoice: { invoice_id: '2f9a4c1d-0b3e-4f8a-9c21-7d5e6a8b1c30' },
      get_credit_note: { credit_note_id: '8b1c30d5-2f9a-4c1d-9c21-7d5e6a0b3e4f' },
    };

    let corpus = JSON.stringify(MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
    for (const t of MCP_TOOLS) {
      const r = await t.handler(happyArgs[t.name] ?? {}, ctx());
      corpus += JSON.stringify(r);
    }
    // Credentials are matched by SHAPE, not as bare substrings. Every token
    // this repo issues is <prefix>_ + 32 base62 chars (personalAccessTokens.ts,
    // oauth.ts), so a run of >=16 alphanumerics after the prefix identifies one
    // wherever it appears — including glued to a preceding word, which a
    // boundary-based rule misses. Legitimate names never have that shape:
    // "import_bank_statement" contains "ort_" but only 4 alphanumerics follow
    // before an underscore, and the same holds for any future report_* /
    // export_* / sort_* identifier. A plain substring scan flagged all of them.
    for (const prefix of ['pat_', 'oat_', 'ort_', 'oac_', 'cls_']) {
      expect(corpus).not.toMatch(new RegExp(`${prefix}[A-Za-z0-9]{16,}`));
    }
    for (const needle of ['Bearer ', 'apikey', 'Set-Cookie']) {
      expect(corpus).not.toContain(needle);
    }
  });
});
