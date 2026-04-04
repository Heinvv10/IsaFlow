// RED phase — written before implementation
/**
 * Unit tests for financialReportingService.ts
 *
 * All SQL calls are mocked.  Tests verify that the service correctly
 * aggregates, classifies, and computes report totals from raw GL data.
 *
 * Fundamental accounting identity tested:
 *   Income Statement : revenue – costOfSales – opEx = netProfit
 *   Balance Sheet    : totalAssets = totalLiabilities + totalEquity
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({
    id:          're-account-uuid',
    accountCode: '3500',
    accountName: 'Retained Earnings',
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { sql } from '@/lib/neon';
import {
  getIncomeStatement,
  getBalanceSheet,
  getVATReturn,
} from '@/modules/accounting/services/financialReportingService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

// ── Shared constants ─────────────────────────────────────────────────────────

const COMPANY_ID   = 'comp-0000-0000-0000-000000000001';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-03-31';
const AS_AT_DATE   = '2026-03-31';

// ═══════════════════════════════════════════════════════════════════════════
// INCOME STATEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('getIncomeStatement', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Returns a raw GL aggregate row as the DB would produce it.
   */
  function glRow(opts: {
    accountCode: string;
    accountName: string;
    accountType: 'revenue' | 'expense';
    accountSubtype?: string;
    debit: number;
    credit: number;
  }) {
    return {
      account_code:    opts.accountCode,
      account_name:    opts.accountName,
      account_type:    opts.accountType,
      account_subtype: opts.accountSubtype ?? null,
      total_debit:     String(opts.debit),
      total_credit:    String(opts.credit),
    };
  }

  it('computes totalRevenue as credit minus debit for revenue accounts', async () => {
    mockSql.mockResolvedValueOnce([
      glRow({ accountCode: '4000', accountName: 'Service Revenue', accountType: 'revenue', debit: 0,      credit: 100000 }),
      glRow({ accountCode: '4100', accountName: 'Product Revenue', accountType: 'revenue', debit: 5000,   credit: 55000  }),
    ]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);

    // 4000: 100000-0=100000; 4100: 55000-5000=50000 → total=150000
    expect(report.totalRevenue).toBe(150000);
    expect(report.revenue).toHaveLength(2);
  });

  it('computes totalCostOfSales from expense rows with cost_of_sales subtype', async () => {
    mockSql.mockResolvedValueOnce([
      glRow({ accountCode: '5000', accountName: 'COGS', accountType: 'expense', accountSubtype: 'cost_of_sales', debit: 60000, credit: 0 }),
    ]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.totalCostOfSales).toBe(60000);
    expect(report.costOfSales).toHaveLength(1);
    expect(report.totalOperatingExpenses).toBe(0);
  });

  it('computes totalOperatingExpenses from expense rows without cost_of_sales subtype', async () => {
    mockSql.mockResolvedValueOnce([
      glRow({ accountCode: '6000', accountName: 'Salaries', accountType: 'expense', debit: 40000, credit: 0 }),
      glRow({ accountCode: '6100', accountName: 'Rent',     accountType: 'expense', debit: 10000, credit: 0 }),
    ]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.totalOperatingExpenses).toBe(50000);
    expect(report.operatingExpenses).toHaveLength(2);
    expect(report.totalCostOfSales).toBe(0);
  });

  it('satisfies the identity: grossProfit = totalRevenue - totalCostOfSales', async () => {
    mockSql.mockResolvedValueOnce([
      glRow({ accountCode: '4000', accountName: 'Revenue',  accountType: 'revenue',  debit: 0,      credit: 200000 }),
      glRow({ accountCode: '5000', accountName: 'COGS',     accountType: 'expense',  accountSubtype: 'cost_of_sales', debit: 80000, credit: 0 }),
      glRow({ accountCode: '6000', accountName: 'Salaries', accountType: 'expense',  debit: 50000,  credit: 0 }),
    ]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.grossProfit).toBe(report.totalRevenue - report.totalCostOfSales);
    expect(report.grossProfit).toBe(120000);
  });

  it('satisfies the identity: netProfit = grossProfit - totalOperatingExpenses', async () => {
    mockSql.mockResolvedValueOnce([
      glRow({ accountCode: '4000', accountName: 'Revenue',  accountType: 'revenue',  debit: 0,     credit: 300000 }),
      glRow({ accountCode: '5000', accountName: 'COGS',     accountType: 'expense',  accountSubtype: 'cost_of_sales', debit: 100000, credit: 0 }),
      glRow({ accountCode: '6000', accountName: 'Salaries', accountType: 'expense',  debit: 80000, credit: 0 }),
      glRow({ accountCode: '6100', accountName: 'Rent',     accountType: 'expense',  debit: 20000, credit: 0 }),
    ]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);

    // grossProfit = 300000 - 100000 = 200000
    // netProfit   = 200000 - (80000 + 20000) = 100000
    expect(report.netProfit).toBe(report.grossProfit - report.totalOperatingExpenses);
    expect(report.netProfit).toBe(100000);
  });

  it('returns zeros for all totals when there are no GL entries', async () => {
    mockSql.mockResolvedValueOnce([]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.totalRevenue).toBe(0);
    expect(report.totalCostOfSales).toBe(0);
    expect(report.grossProfit).toBe(0);
    expect(report.totalOperatingExpenses).toBe(0);
    expect(report.netProfit).toBe(0);
    expect(report.revenue).toEqual([]);
    expect(report.costOfSales).toEqual([]);
    expect(report.operatingExpenses).toEqual([]);
  });

  it('excludes line items where amount rounds to zero (|amount| ≤ 0.001)', async () => {
    mockSql.mockResolvedValueOnce([
      // debit == credit → amount = 0 — should be filtered out
      glRow({ accountCode: '4000', accountName: 'Net-Zero Revenue', accountType: 'revenue', debit: 500, credit: 500 }),
    ]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.revenue).toHaveLength(0);
    expect(report.totalRevenue).toBe(0);
  });

  it('attaches period metadata to the report', async () => {
    mockSql.mockResolvedValueOnce([]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.periodStart).toBe(PERIOD_START);
    expect(report.periodEnd).toBe(PERIOD_END);
  });

  it('handles a net loss (negative netProfit) correctly', async () => {
    mockSql.mockResolvedValueOnce([
      glRow({ accountCode: '4000', accountName: 'Revenue',  accountType: 'revenue', debit: 0,      credit: 50000 }),
      glRow({ accountCode: '6000', accountName: 'Expenses', accountType: 'expense', debit: 80000,  credit: 0    }),
    ]);

    const report = await getIncomeStatement(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.netProfit).toBe(-30000);
  });

  it('populates comparativePeriod fields when comparePeriod is provided', async () => {
    const priorRows = [
      glRow({ accountCode: '4000', accountName: 'Revenue', accountType: 'revenue', debit: 0, credit: 80000 }),
    ];
    const currentRows = [
      glRow({ accountCode: '4000', accountName: 'Revenue', accountType: 'revenue', debit: 0, credit: 100000 }),
    ];

    // getIncomeStatement calls fetchIncomeStatementRows twice (current + prior) via Promise.all
    mockSql
      .mockResolvedValueOnce(currentRows)
      .mockResolvedValueOnce(priorRows);

    const report = await getIncomeStatement(
      COMPANY_ID, PERIOD_START, PERIOD_END,
      {},
      { start: '2025-01-01', end: '2025-03-31' },
    );

    expect(report.priorTotalRevenue).toBe(80000);
    expect(report.totalRevenue).toBe(100000);
    expect(report.comparativePeriod).toEqual({ start: '2025-01-01', end: '2025-03-31' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BALANCE SHEET
// ═══════════════════════════════════════════════════════════════════════════

describe('getBalanceSheet', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Build a raw BS aggregate row.
   * normalBalance governs sign: debit-normal → balance = debit - credit
   *                             credit-normal → balance = credit - debit
   */
  function bsRow(opts: {
    accountCode:   string;
    accountName:   string;
    accountType:   'asset' | 'liability' | 'equity';
    normalBalance: 'debit' | 'credit';
    debit:         number;
    credit:        number;
  }) {
    return {
      account_code:   opts.accountCode,
      account_name:   opts.accountName,
      account_type:   opts.accountType,
      normal_balance: opts.normalBalance,
      total_debit:    String(opts.debit),
      total_credit:   String(opts.credit),
    };
  }

  it('computes totalAssets as sum of debit-normal asset balances', async () => {
    // getBalanceSheet calls fetchBalanceSheetData (1 sql) + calculateRetainedEarnings (1 sql)
    mockSql
      .mockResolvedValueOnce([
        bsRow({ accountCode: '1000', accountName: 'Cash',       accountType: 'asset', normalBalance: 'debit', debit: 150000, credit: 0      }),
        bsRow({ accountCode: '1100', accountName: 'Debtors',    accountType: 'asset', normalBalance: 'debit', debit: 200000, credit: 50000  }),
      ])
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }]); // retained earnings

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);

    // 1000: 150000-0=150000; 1100: 200000-50000=150000 → total=300000
    expect(report.totalAssets).toBe(300000);
    expect(report.assets).toHaveLength(2);
  });

  it('computes totalLiabilities as sum of credit-normal liability balances', async () => {
    mockSql
      .mockResolvedValueOnce([
        bsRow({ accountCode: '2000', accountName: 'Creditors',  accountType: 'liability', normalBalance: 'credit', debit: 0,     credit: 80000 }),
        bsRow({ accountCode: '2100', accountName: 'VAT Payable', accountType: 'liability', normalBalance: 'credit', debit: 5000,  credit: 20000 }),
      ])
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }]);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);

    // 2000: 80000-0=80000; 2100: 20000-5000=15000 → total=95000
    expect(report.totalLiabilities).toBe(95000);
  });

  it('satisfies the accounting equation: assets = liabilities + equity', async () => {
    // Assets: Cash 200000 (debit-normal, balance=200000)
    // Liabilities: Creditors 50000 (credit-normal, balance=50000)
    // Equity: Share capital 150000 (credit-normal, balance=150000)
    // Retained earnings added separately: 0 in this scenario
    mockSql
      .mockResolvedValueOnce([
        bsRow({ accountCode: '1000', accountName: 'Cash',          accountType: 'asset',     normalBalance: 'debit',  debit: 200000, credit: 0      }),
        bsRow({ accountCode: '2000', accountName: 'Creditors',     accountType: 'liability', normalBalance: 'credit', debit: 0,      credit: 50000  }),
        bsRow({ accountCode: '3000', accountName: 'Share Capital', accountType: 'equity',    normalBalance: 'credit', debit: 0,      credit: 150000 }),
      ])
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }]);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);

    expect(report.totalAssets).toBe(report.totalLiabilities + report.totalEquity);
  });

  it('adds retained earnings to the equity section when non-zero', async () => {
    // No equity accounts in the chart yet, only P&L history
    mockSql
      .mockResolvedValueOnce([
        bsRow({ accountCode: '1000', accountName: 'Cash', accountType: 'asset', normalBalance: 'debit', debit: 100000, credit: 0 }),
      ])
      // calculateRetainedEarnings: revenue=120000, expenses=80000 → RE=40000
      .mockResolvedValueOnce([{ revenue: '120000', expenses: '80000' }]);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);

    const reItem = report.equity.find(e => e.accountName.toLowerCase().includes('retained'));
    expect(reItem).toBeDefined();
    expect(reItem!.balance).toBe(40000);
    expect(report.totalEquity).toBe(40000);
  });

  it('excludes accounts with balance < 0.01 (rounds to zero)', async () => {
    mockSql
      .mockResolvedValueOnce([
        // debit == credit → balance = 0.00 → excluded
        bsRow({ accountCode: '1000', accountName: 'Cleared Account', accountType: 'asset', normalBalance: 'debit', debit: 100, credit: 100 }),
      ])
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }]);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);
    expect(report.assets).toHaveLength(0);
    expect(report.totalAssets).toBe(0);
  });

  it('returns all-zero totals when no GL lines exist', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }]);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);
    expect(report.totalAssets).toBe(0);
    expect(report.totalLiabilities).toBe(0);
    expect(report.totalEquity).toBe(0);
  });

  it('attaches asAtDate to the report', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }]);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);
    expect(report.asAtDate).toBe(AS_AT_DATE);
  });

  it('populates prior totals when compareDate is provided', async () => {
    // getBalanceSheet runs Promise.all([fetchBalanceSheetData(current), fetchBalanceSheetData(prior)]).
    // Each fetchBalanceSheetData makes two sequential sql calls:
    //   1. balance rows  2. calculateRetainedEarnings rows
    // Because both coroutines are interleaved by Promise.all, the actual mock-call
    // order is: current-balance, prior-balance, current-RE, prior-RE.
    mockSql
      .mockResolvedValueOnce([                                          // call 1: current balance rows
        bsRow({ accountCode: '1000', accountName: 'Cash', accountType: 'asset', normalBalance: 'debit', debit: 200000, credit: 0 }),
      ])
      .mockResolvedValueOnce([                                          // call 2: prior balance rows
        bsRow({ accountCode: '1000', accountName: 'Cash', accountType: 'asset', normalBalance: 'debit', debit: 150000, credit: 0 }),
      ])
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }])         // call 3: current RE
      .mockResolvedValueOnce([{ revenue: '0', expenses: '0' }]);        // call 4: prior RE

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE, undefined, '2025-12-31');

    expect(report.totalAssets).toBe(200000);
    expect(report.priorTotalAssets).toBe(150000);
    expect(report.compareDate).toBe('2025-12-31');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VAT RETURN
// ═══════════════════════════════════════════════════════════════════════════

describe('getVATReturn', () => {
  beforeEach(() => vi.clearAllMocks());

  function vatLine(opts: {
    accountType:    'liability' | 'asset';
    accountSubtype: 'vat_output' | 'vat_input';
    vatType:        string | null;
    debit:          number;
    credit:         number;
    journalEntryId?: string;
    entryNumber?:    string;
    entryDate?:      string;
  }) {
    return {
      line_id:           'line-001',
      gl_account_id:     'acct-001',
      debit:             String(opts.debit),
      credit:            String(opts.credit),
      vat_type:          opts.vatType,
      line_description:  'VAT on sale',
      journal_entry_id:  opts.journalEntryId ?? 'je-001',
      entry_number:      opts.entryNumber    ?? 'JE-0001',
      entry_date:        opts.entryDate      ?? '2026-02-15',
      entry_description: 'Customer invoice 001',
      source_document_id: null,
      account_code:      opts.accountSubtype === 'vat_output' ? '2200' : '1200',
      account_name:      opts.accountSubtype === 'vat_output' ? 'VAT Output' : 'VAT Input',
      account_type:      opts.accountType,
      account_subtype:   opts.accountSubtype,
    };
  }

  it('computes totalOutputTax as sum of credit-minus-debit for output VAT lines', async () => {
    mockSql.mockResolvedValueOnce([
      vatLine({ accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', debit: 0, credit: 15000 }),
      vatLine({ accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', debit: 0, credit:  5000 }),
    ]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.totalOutputTax).toBe(20000);
    expect(report.outputVAT).toBe(20000);
  });

  it('computes totalInputTax as sum of debit-minus-credit for input VAT lines', async () => {
    mockSql.mockResolvedValueOnce([
      vatLine({ accountType: 'asset', accountSubtype: 'vat_input', vatType: 'standard', debit: 6000, credit: 0 }),
      vatLine({ accountType: 'asset', accountSubtype: 'vat_input', vatType: 'standard', debit: 4000, credit: 0 }),
    ]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.totalInputTax).toBe(10000);
    expect(report.inputVAT).toBe(10000);
  });

  it('computes netVAT = totalOutputTax - totalInputTax', async () => {
    mockSql.mockResolvedValueOnce([
      vatLine({ accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', debit: 0,    credit: 20000 }),
      vatLine({ accountType: 'asset',     accountSubtype: 'vat_input',  vatType: 'standard', debit: 8000, credit: 0     }),
    ]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.netVAT).toBe(12000);
  });

  it('returns zero totals and empty box lists when no VAT lines exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.totalOutputTax).toBe(0);
    expect(report.totalInputTax).toBe(0);
    expect(report.netVAT).toBe(0);
  });

  it('routes unclassified output lines (vat_type NULL) into Box 1', async () => {
    mockSql.mockResolvedValueOnce([
      vatLine({ accountType: 'liability', accountSubtype: 'vat_output', vatType: null, debit: 0, credit: 7500 }),
    ]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    const box1 = report.outputBoxes.find(b => b.box === '1');
    expect(box1).toBeDefined();
    expect(box1!.amount).toBeCloseTo(7500, 2);
  });

  it('routes unclassified input lines (vat_type NULL) into Box 15', async () => {
    mockSql.mockResolvedValueOnce([
      vatLine({ accountType: 'asset', accountSubtype: 'vat_input', vatType: null, debit: 3000, credit: 0 }),
    ]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    const box15 = report.inputBoxes.find(b => b.box === '15');
    expect(box15).toBeDefined();
    expect(box15!.amount).toBeCloseTo(3000, 2);
  });

  it('populates outputDetails with non-zero boxes only', async () => {
    mockSql.mockResolvedValueOnce([
      vatLine({ accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', debit: 0, credit: 10000 }),
    ]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.outputDetails.length).toBeGreaterThan(0);
    expect(report.outputDetails[0]!.amount).toBeGreaterThan(0);
  });

  it('attaches period metadata to the report', async () => {
    mockSql.mockResolvedValueOnce([]);

    const report = await getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(report.periodStart).toBe(PERIOD_START);
    expect(report.periodEnd).toBe(PERIOD_END);
  });

  it('propagates sql errors to the caller', async () => {
    mockSql.mockRejectedValueOnce(new Error('query timeout'));
    await expect(getVATReturn(COMPANY_ID, PERIOD_START, PERIOD_END)).rejects.toThrow('query timeout');
  });
});
