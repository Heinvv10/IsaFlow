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
import { InvalidCursorError } from '@/modules/accounting/services/bank/bankTxCursor';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';

import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
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
    vi.mocked(getCustomerInvoiceDetail).mockResolvedValue({ id: '4cd9b767-2d7f-4ee8-8b51-fb1e049f6903', items: [] });
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
      get_invoice: { invoice_id: '4cd9b767-2d7f-4ee8-8b51-fb1e049f6903' },
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
