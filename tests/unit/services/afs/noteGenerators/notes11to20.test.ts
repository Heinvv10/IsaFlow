// tests/unit/services/afs/noteGenerators/notes11to20.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockUnsafe } from '../../../helpers/sqlFragmentMock';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: mockUnsafe }) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
// The fiscal calendar is resolved from company settings and has its own tests
// (tests/unit/services/afs/afsFiscalPeriod.test.ts). Mocking it here keeps
// these generator tests about the note CONTENT, and keeps the sql mock
// sequences below counting only the generator's own queries.
vi.mock('@/modules/accounting/services/afs/afsFiscalPeriod', () => ({
  getFiscalRange: vi.fn(async () => ({ start: '2026-01-01', end: '2026-12-31' })),
}));
// Note generators call getCompanyTerminology which issues its own SELECT.
// Stub it so the test's mockSql.mockResolvedValueOnce chains are not
// consumed by the terminology lookup.
vi.mock('@/modules/accounting/services/afs/entityTerminology', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/afs/entityTerminology')>();
  return {
    ...actual,
    getCompanyTerminology: vi.fn().mockResolvedValue(actual.getTerminology('pty')),
  };
});

import { sql } from '@/lib/neon';
import {
  generateNote11CashAndCashEquivalents,
  generateNote12ShareCapital,
  generateNote13Borrowings,
  generateNote14LeaseLiabilities,
  generateNote15Provisions,
  generateNote16TradePayables,
  generateNote17IncomeTax,
  generateNote18RevenueDisaggregation,
  generateNote19OtherIncome,
  generateNote20OperatingExpenses,
} from '@/modules/accounting/services/afs/noteGenerators/notes11to20';

const COMPANY_ID = 'ccc-test-0000-0000-0000-000000000011';
const FISCAL_YEAR = 2024;
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

describe('notes11to20 generators', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─── Note 11 ─────────────────────────────────────────────────────────────

  describe('generateNote11CashAndCashEquivalents', () => {
    it('returns paragraph and table blocks with cash accounts', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'FNB Current', account_code: '1001', balance: 50000 },
        { account_name: 'Petty Cash', account_code: '1002', balance: 1500 },
      ]);

      const result = await generateNote11CashAndCashEquivalents(COMPANY_ID, FISCAL_YEAR);

      expect(result.dataSnapshot).toHaveProperty('cashAccounts');
      expect((result.dataSnapshot.cashAccounts as unknown[]).length).toBe(2);

      const blocks = result.content.blocks;
      const para = blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeTruthy();

      const table = blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Bank Account', 'Code', 'Balance (R)']);
        // 2 data rows + 1 totals row
        expect(table.rows.length).toBe(3);
      }
    });

    it('still returns table with totals row when no cash accounts (never suppress)', async () => {
      sqlMock.mockResolvedValueOnce([]);

      const result = await generateNote11CashAndCashEquivalents(COMPANY_ID, FISCAL_YEAR);

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        // Only the totals row
        expect(table.rows.length).toBe(1);
      }
    });

    it('calls sql exactly once', async () => {
      sqlMock.mockResolvedValueOnce([]);
      await generateNote11CashAndCashEquivalents(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Note 12 ─────────────────────────────────────────────────────────────

  describe('generateNote12ShareCapital', () => {
    it('returns paragraph and table blocks', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'Ordinary Share Capital', account_code: '3001', account_subtype: 'share_capital', balance: 1000 },
      ]);

      const result = await generateNote12ShareCapital(COMPANY_ID, FISCAL_YEAR);

      const para = result.content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeTruthy();

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Account', 'Code', 'Subtype', 'Balance']);
      }
    });

    it('never suppresses even when no equity rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote12ShareCapital(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks.length).toBeGreaterThan(0);
    });
  });

  // ─── Note 13 ─────────────────────────────────────────────────────────────

  describe('generateNote13Borrowings', () => {
    it('returns borrowings table when data exists', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'FNB Business Loan', account_code: '2100', account_subtype: 'bank_loan', balance: 250000 },
      ]);

      const result = await generateNote13Borrowings(COMPANY_ID, FISCAL_YEAR);

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Facility', 'Code', 'Type', 'Balance']);
      }
    });

    it('suppresses (returns empty blocks) when no borrowing rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote13Borrowings(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks).toHaveLength(0);
    });
  });

  // ─── Note 14 ─────────────────────────────────────────────────────────────

  describe('generateNote14LeaseLiabilities', () => {
    it('returns placeholder content without querying DB', async () => {
      const result = await generateNote14LeaseLiabilities(COMPANY_ID, FISCAL_YEAR);

      expect(sqlMock).not.toHaveBeenCalled();
      expect(result.dataSnapshot).toHaveProperty('suppressReason', 'table_not_implemented');
      expect(result.dataSnapshot.leases).toEqual([]);

      expect(result.content.title).toBe('Lease Liabilities (IFRS 16)');
      const para = result.content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeTruthy();
      if (para?.type === 'paragraph') {
        expect(para.text).toContain('IFRS 16');
      }
    });
  });

  // ─── Note 15 ─────────────────────────────────────────────────────────────

  describe('generateNote15Provisions', () => {
    it('returns provisions table when data exists', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'Leave Pay Provision', account_subtype: 'leave_pay_provision', balance: 45000 },
      ]);

      const result = await generateNote15Provisions(COMPANY_ID, FISCAL_YEAR);

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Provision', 'Type', 'Balance']);
      }
    });

    it('suppresses when no provision rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote15Provisions(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks).toHaveLength(0);
    });
  });

  // ─── Note 16 ─────────────────────────────────────────────────────────────

  describe('generateNote16TradePayables', () => {
    it('returns two tables (summary + aging) and never suppresses', async () => {
      sqlMock.mockResolvedValueOnce([
        { gross_payables: 120000, current_amount: 80000, days_30: 30000, days_60_plus: 10000 },
      ]);

      const result = await generateNote16TradePayables(COMPANY_ID, FISCAL_YEAR);

      const tables = result.content.blocks.filter((b) => b.type === 'table');
      expect(tables.length).toBe(2);
      if (tables[0]?.type === 'table') {
        expect(tables[0].headers).toEqual(['', 'Amount (R)']);
      }
      if (tables[1]?.type === 'table') {
        expect(tables[1].headers).toEqual(['Current', '30 days', '60+ days', 'Total']);
      }
    });

    it('still shows tables with zero values when no payables', async () => {
      sqlMock.mockResolvedValueOnce([{ gross_payables: null, current_amount: null, days_30: null, days_60_plus: null }]);
      const result = await generateNote16TradePayables(COMPANY_ID, FISCAL_YEAR);
      const tables = result.content.blocks.filter((b) => b.type === 'table');
      expect(tables.length).toBe(2);
    });
  });

  // ─── Note 17 ─────────────────────────────────────────────────────────────

  describe('generateNote17IncomeTax', () => {
    it('runs two sql queries via Promise.all and returns combined table', async () => {
      sqlMock
        .mockResolvedValueOnce([{ current_tax: 28000, deferred_tax: -3000 }])
        .mockResolvedValueOnce([{ dta: 5000, dtl: 8000 }]);

      const result = await generateNote17IncomeTax(COMPANY_ID, FISCAL_YEAR);

      expect(sqlMock).toHaveBeenCalledTimes(2);

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['', 'Amount (R)']);
        // 5 rows: current tax, deferred tax, total, dta, dtl
        expect(table.rows.length).toBe(5);
        expect(table.rows[0][0]).toBe('Current tax expense');
        expect(table.rows[2][0]).toBe('Total tax expense');
        expect(table.rows[3][0]).toBe('Deferred tax asset');
        expect(table.rows[4][0]).toBe('Deferred tax liability');
      }
    });

    it('never suppresses when all values are zero', async () => {
      sqlMock
        .mockResolvedValueOnce([{ current_tax: null, deferred_tax: null }])
        .mockResolvedValueOnce([{ dta: null, dtl: null }]);

      const result = await generateNote17IncomeTax(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks.length).toBeGreaterThan(0);
    });
  });

  // ─── Note 18 ─────────────────────────────────────────────────────────────

  describe('generateNote18RevenueDisaggregation', () => {
    it('returns revenue table with total row', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'Service Revenue', account_code: '4001', account_subtype: 'service_revenue', net_amount: 500000 },
        { account_name: 'Product Sales', account_code: '4002', account_subtype: 'product_revenue', net_amount: 200000 },
      ]);

      const result = await generateNote18RevenueDisaggregation(COMPANY_ID, FISCAL_YEAR);

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Revenue Stream', 'Code', 'Amount']);
        // 2 data rows + 1 total row
        expect(table.rows.length).toBe(3);
      }
    });

    it('suppresses when no revenue rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote18RevenueDisaggregation(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks).toHaveLength(0);
    });
  });

  // ─── Note 19 ─────────────────────────────────────────────────────────────

  describe('generateNote19OtherIncome', () => {
    it('returns other income table', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'Interest Income', account_subtype: 'interest_income', net_amount: 8000 },
      ]);

      const result = await generateNote19OtherIncome(COMPANY_ID, FISCAL_YEAR);

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Description', 'Type', 'Amount']);
      }
    });

    it('suppresses when no other income rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote19OtherIncome(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks).toHaveLength(0);
    });
  });

  // ─── Note 20 ─────────────────────────────────────────────────────────────

  describe('generateNote20OperatingExpenses', () => {
    it('returns expense table with total row', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'Staff Costs', account_subtype: 'salaries', net_amount: 180000 },
        { account_name: 'Rent', account_subtype: 'rent', net_amount: 60000 },
      ]);

      const result = await generateNote20OperatingExpenses(COMPANY_ID, FISCAL_YEAR);

      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeTruthy();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Expense', 'Category', 'Amount']);
        // 2 data rows + 1 total row
        expect(table.rows.length).toBe(3);
      }
    });

    it('suppresses when no expense rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote20OperatingExpenses(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks).toHaveLength(0);
    });
  });
});
