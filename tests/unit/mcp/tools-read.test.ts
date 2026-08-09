/**
 * MCP read tools — MCP Phase 2, Task 2.6.
 *
 * Per-tool: happy path returns ok(data); the service receives ctx.companyId
 * (never an args-supplied company); misses return the generic NOT_FOUND text.
 * Suite-wide: token-scan (no credential material in any envelope/manifest)
 * and manifest shape (17 read tools, write:false, additionalProperties:false).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    fmtDate: vi.fn(() => '2026-07-19'),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/trialBalanceService', () => ({ getTrialBalance: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({ getFiscalPeriodIdForDate: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/incomeStatementService', () => ({ getIncomeStatement: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ getBalanceSheet: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({ getARAging: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAging: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/accountLedgerService', () => ({ getAccountLedger: vi.fn() }));
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
vi.mock('@/modules/accounting/services/reports/vatReturnService', () => ({ getVATReturn: vi.fn() }));

import { getCompany } from '@/modules/accounting/services/core/companyService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
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
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';

import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

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
    parseOk(await tool('balance_sheet').handler({}, ctx()));
    expect(getBalanceSheet).toHaveBeenCalledWith(COMPANY_ID, '2026-07-19');
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
      { status: 'sent', customer_id: 'cust-1', limit: 500 }, ctx(),
    ));
    expect(listCustomerInvoices).toHaveBeenCalledWith(COMPANY_ID, {
      status: ['sent'], clientId: 'cust-1', search: null, limit: 100,
    });
  });

  it('get_invoice: cross-tenant probe reads identically to a genuine miss', async () => {
    vi.mocked(getCustomerInvoiceDetail).mockResolvedValue(null);
    const r = await tool('get_invoice').handler({ invoice_id: 'someone-elses-invoice' }, ctx());
    expect(getCustomerInvoiceDetail).toHaveBeenCalledWith(COMPANY_ID, 'someone-elses-invoice');
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
    expect(getBankAccountsStatus).toHaveBeenCalledWith(COMPANY_ID);
    expect(getBankTransactions).toHaveBeenCalledWith(
      COMPANY_ID, expect.objectContaining({ allocationFilter: 'unallocated', limit: 50 }),
    );
  });

  it('vat_status requires the period and passes companyId first', async () => {
    vi.mocked(getVATReturn).mockResolvedValue({ netVAT: 0 } as never);
    parseOk(await tool('vat_status').handler(
      { period_start: '2026-05-01', period_end: '2026-06-30' }, ctx(),
    ));
    expect(getVATReturn).toHaveBeenCalledWith(COMPANY_ID, '2026-05-01', '2026-06-30');
    const bad = await tool('vat_status').handler({}, ctx());
    expect(bad.isError).toBe(true);
  });
});

describe('suite-wide invariants', () => {
  const READ_TOOLS = MCP_TOOLS.filter((t) => !t.write);

  it('exactly 17 read tools, all write:false, additionalProperties:false everywhere', () => {
    expect(READ_TOOLS).toHaveLength(17);
    // Every registered tool is drift-guarded against CLIENT_MCP_TOOL_NAMES.
    expect(MCP_TOOLS).toHaveLength(CLIENT_MCP_TOOL_NAMES.length);
    for (const t of READ_TOOLS) {
      expect(t.write).toBe(false);
      expect(t.requiresPost).toBeUndefined();
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('no tool (read OR write) accepts a company identifier in its schema', () => {
    for (const t of MCP_TOOLS) {
      const props = Object.keys(
        ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      );
      for (const p of props) {
        expect(p).not.toMatch(/company/i);
      }
    }
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
    vi.mocked(listCustomerInvoices).mockResolvedValue({ invoices: [], total: 0 });
    vi.mocked(getCustomerInvoiceDetail).mockResolvedValue({ id: 'i1', items: [] });
    vi.mocked(getQuotes).mockResolvedValue({ quotes: [], total: 0 } as never);
    vi.mocked(listCustomers).mockResolvedValue([]);
    vi.mocked(listSuppliers).mockResolvedValue({ suppliers: [], total: 0 });
    vi.mocked(getBankAccountsStatus).mockResolvedValue([]);
    vi.mocked(getBankTransactions).mockResolvedValue({ transactions: [], total: 0 } as never);
    vi.mocked(getVATReturn).mockResolvedValue({} as never);

    const happyArgs: Record<string, Record<string, unknown>> = {
      profit_and_loss: { period_start: '2026-06-01', period_end: '2026-06-30' },
      vat_status: { period_start: '2026-05-01', period_end: '2026-06-30' },
      search_gl: { account_code: '1000', from_date: '2026-01-01', to_date: '2026-06-30' },
      get_invoice: { invoice_id: 'i1' },
    };

    let corpus = JSON.stringify(MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
    for (const t of MCP_TOOLS) {
      const r = await t.handler(happyArgs[t.name] ?? {}, ctx());
      corpus += JSON.stringify(r);
    }
    // Credential prefixes are matched at a token boundary rather than as bare
    // substrings. "import_bank_statement" contains "ort_", as would any future
    // report_* or export_* tool — a substring scan flags those as leaked
    // credentials. A real credential starts its token (`"token":"ort_1a2b…"`),
    // so require a non-word character before the prefix and credential
    // characters after it. Still catches a token anywhere in the corpus.
    for (const prefix of ['pat_', 'oat_', 'ort_', 'oac_', 'cls_']) {
      expect(corpus).not.toMatch(new RegExp(`(?:^|[^A-Za-z0-9_])${prefix}[A-Za-z0-9]`));
    }
    for (const needle of ['Bearer ', 'apikey', 'Set-Cookie']) {
      expect(corpus).not.toContain(needle);
    }
  });
});
