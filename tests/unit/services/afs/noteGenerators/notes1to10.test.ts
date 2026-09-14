import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
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
// Notes 10 and 16 are the aged report at the year end, summed (R-059). The
// ageing's own arithmetic is pinned against a database in
// tests/integration/r059-year-end-notes-agree-with-ageing.int.test.ts; here the
// totals are stubbed so these tests stay about the note CONTENT and the date
// it asks for.
vi.mock('@/modules/accounting/services/reports/agedBucketTotals', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/reports/agedBucketTotals')>();
  return { ...actual, getAgedBucketTotals: vi.fn() };
});

import { sql } from '@/lib/neon';
import { getAgedBucketTotals } from '@/modules/accounting/services/reports/agedBucketTotals';
import {
  generateNote1AccountingPolicies,
  generateNote2SignificantEstimates,
  generateNote3PropertyPlantEquipment,
  generateNote4RightOfUseAssets,
  generateNote5IntangibleAssets,
  generateNote6InvestmentProperty,
  generateNote7InvestmentsInAssociates,
  generateNote8FinancialAssets,
  generateNote9Inventories,
  generateNote10TradeReceivables,
} from '@/modules/accounting/services/afs/noteGenerators/notes1to10';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'ccc11111-0000-0000-0000-000000000001';
const FISCAL_YEAR = 2025;

describe('notes1to10 generators', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Note 1 ────────────────────────────────────────────────────────────────

  describe('generateNote1AccountingPolicies', () => {
    it('returns dataSnapshot and content', async () => {
      mockSql.mockResolvedValueOnce([
        {
          depreciation_method: 'straight-line',
          inventory_valuation_method: 'weighted average cost',
          default_currency: 'ZAR',
          vat_system_type: 'invoice',
        },
      ]);

      const result = await generateNote1AccountingPolicies(COMPANY_ID, FISCAL_YEAR);
      expect(result).toHaveProperty('dataSnapshot');
      expect(result).toHaveProperty('content');
    });

    it('content title is Accounting Policies', async () => {
      mockSql.mockResolvedValueOnce([{}]);
      const { content } = await generateNote1AccountingPolicies(COMPANY_ID, FISCAL_YEAR);
      expect(content.title).toBe('Accounting Policies');
    });

    it('content has a paragraph block containing policy text', async () => {
      mockSql.mockResolvedValueOnce([
        {
          depreciation_method: 'straight-line',
          inventory_valuation_method: 'weighted average cost',
          default_currency: 'ZAR',
          vat_system_type: 'invoice',
        },
      ]);
      const { content } = await generateNote1AccountingPolicies(COMPANY_ID, FISCAL_YEAR);
      // Accounting policies renders a sequence of paragraphs — basis of
      // preparation first, then individual policies. Verify at least one
      // carries the characteristic "straight-line" depreciation text.
      const paragraphs = content.blocks.filter((b) => b.type === 'paragraph') as Array<{ type: 'paragraph'; text: string }>;
      expect(paragraphs.length).toBeGreaterThan(0);
      expect(paragraphs.some(p => /straight-line/i.test(p.text))).toBe(true);
    });

    it('uses defaults when company row is missing', async () => {
      mockSql.mockResolvedValueOnce([]);
      const { content } = await generateNote1AccountingPolicies(COMPANY_ID, FISCAL_YEAR);
      expect(content.blocks.length).toBeGreaterThan(0);
    });
  });

  // ── Note 2 ────────────────────────────────────────────────────────────────

  describe('generateNote2SignificantEstimates', () => {
    it('returns dataSnapshot and content', async () => {
      mockSql.mockResolvedValueOnce([
        { account_subtype: 'provision', account_name: 'Bad Debt Provision', net_balance: '50000' },
      ]);
      const result = await generateNote2SignificantEstimates(COMPANY_ID, FISCAL_YEAR);
      expect(result).toHaveProperty('dataSnapshot');
      expect(result).toHaveProperty('content');
    });

    it('returns suppress reason when no rows', async () => {
      mockSql.mockResolvedValueOnce([]);
      const { dataSnapshot } = await generateNote2SignificantEstimates(COMPANY_ID, FISCAL_YEAR);
      expect((dataSnapshot as { suppressReason?: string }).suppressReason).toBe('zero_balance');
    });

    it('includes list block of subtypes when rows exist', async () => {
      mockSql.mockResolvedValueOnce([
        { account_subtype: 'provision', account_name: 'Provision A', net_balance: '1000' },
        { account_subtype: 'impairment', account_name: 'Impairment B', net_balance: '2000' },
      ]);
      const { content } = await generateNote2SignificantEstimates(COMPANY_ID, FISCAL_YEAR);
      const list = content.blocks.find((b) => b.type === 'list');
      expect(list).toBeDefined();
    });
  });

  // ── Note 3 ────────────────────────────────────────────────────────────────

  describe('generateNote3PropertyPlantEquipment', () => {
    it('returns dataSnapshot and content', async () => {
      mockSql.mockResolvedValueOnce([
        {
          category: 'Motor Vehicles',
          total_cost: '500000',
          total_accum_dep: '100000',
          total_carrying_value: '400000',
          additions: '50000',
          disposals: '0',
        },
      ]);
      const result = await generateNote3PropertyPlantEquipment(COMPANY_ID, FISCAL_YEAR);
      expect(result).toHaveProperty('dataSnapshot');
      expect(result).toHaveProperty('content');
    });

    it('content includes table with correct headers', async () => {
      mockSql.mockResolvedValueOnce([
        {
          category: 'Equipment',
          total_cost: '200000',
          total_accum_dep: '40000',
          total_carrying_value: '160000',
          additions: '20000',
          disposals: '0',
        },
      ]);
      const { content } = await generateNote3PropertyPlantEquipment(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.find((b) => b.type === 'table') as
        | { type: 'table'; headers: string[]; rows: string[][] }
        | undefined;
      expect(table).toBeDefined();
      expect(table!.headers).toEqual([
        'Category',
        'Cost',
        'Accum Depr',
        'Carrying Value',
        'Additions',
        'Disposals',
      ]);
    });

    it('includes a totals row when data exists', async () => {
      mockSql.mockResolvedValueOnce([
        {
          category: 'Equipment',
          total_cost: '200000',
          total_accum_dep: '40000',
          total_carrying_value: '160000',
          additions: '0',
          disposals: '0',
        },
      ]);
      const { content } = await generateNote3PropertyPlantEquipment(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.find((b) => b.type === 'table') as
        | { type: 'table'; headers: string[]; rows: string[][] }
        | undefined;
      expect(table).toBeDefined();
      // data row + totals row
      expect(table!.rows.length).toBeGreaterThanOrEqual(2);
      expect(table!.rows[table!.rows.length - 1][0]).toBe('Total');
    });

    it('sets suppressReason when no assets', async () => {
      mockSql.mockResolvedValueOnce([]);
      const { dataSnapshot } = await generateNote3PropertyPlantEquipment(COMPANY_ID, FISCAL_YEAR);
      expect((dataSnapshot as { suppressReason?: string }).suppressReason).toBe('zero_balance');
    });
  });

  // ── Note 4 ────────────────────────────────────────────────────────────────

  describe('generateNote4RightOfUseAssets', () => {
    it('returns placeholder without DB call', async () => {
      const result = await generateNote4RightOfUseAssets(COMPANY_ID, FISCAL_YEAR);
      expect(result.dataSnapshot).toHaveProperty('suppressReason', 'table_not_implemented');
      expect(result.content.title).toBe('Right-of-Use Assets');
      const para = result.content.blocks.find((b) => b.type === 'paragraph') as
        | { type: 'paragraph'; text: string }
        | undefined;
      expect(para).toBeDefined();
      expect(para!.text).toContain('IFRS 16');
      expect(mockSql).not.toHaveBeenCalled();
    });
  });

  // ── Note 5 ────────────────────────────────────────────────────────────────

  describe('generateNote5IntangibleAssets', () => {
    it('suppresses with zero_balance when no intangible asset rows exist', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await generateNote5IntangibleAssets(COMPANY_ID, FISCAL_YEAR);
      expect(result.dataSnapshot).toHaveProperty('suppressReason', 'zero_balance');
      expect(result.content.title).toBe('Intangible Assets');
      expect(mockSql).toHaveBeenCalled();
    });
  });

  // ── Note 6 ────────────────────────────────────────────────────────────────

  describe('generateNote6InvestmentProperty', () => {
    it('returns placeholder without DB call', async () => {
      const result = await generateNote6InvestmentProperty(COMPANY_ID, FISCAL_YEAR);
      expect(result.dataSnapshot).toHaveProperty('suppressReason', 'table_not_implemented');
      expect(result.content.title).toBe('Investment Property');
      expect(mockSql).not.toHaveBeenCalled();
    });
  });

  // ── Note 7 ────────────────────────────────────────────────────────────────

  describe('generateNote7InvestmentsInAssociates', () => {
    it('returns placeholder without DB call', async () => {
      const result = await generateNote7InvestmentsInAssociates(COMPANY_ID, FISCAL_YEAR);
      expect(result.dataSnapshot).toHaveProperty('suppressReason', 'table_not_implemented');
      expect(result.content.title).toBe('Investments in Associates');
      expect(mockSql).not.toHaveBeenCalled();
    });
  });

  // ── Note 8 ────────────────────────────────────────────────────────────────

  describe('generateNote8FinancialAssets', () => {
    it('returns dataSnapshot and content', async () => {
      mockSql.mockResolvedValueOnce([
        { account_name: 'Listed Equities', account_subtype: 'investment', balance: '150000' },
      ]);
      const result = await generateNote8FinancialAssets(COMPANY_ID, FISCAL_YEAR);
      expect(result).toHaveProperty('dataSnapshot');
      expect(result).toHaveProperty('content');
    });

    it('table has correct headers', async () => {
      mockSql.mockResolvedValueOnce([
        { account_name: 'Loan to Director', account_subtype: 'loan_receivable', balance: '50000' },
      ]);
      const { content } = await generateNote8FinancialAssets(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.find((b) => b.type === 'table') as
        | { type: 'table'; headers: string[]; rows: string[][] }
        | undefined;
      expect(table).toBeDefined();
      expect(table!.headers).toEqual(['Account', 'Classification', 'Balance']);
    });

    it('sets suppressReason when no rows', async () => {
      mockSql.mockResolvedValueOnce([]);
      const { dataSnapshot } = await generateNote8FinancialAssets(COMPANY_ID, FISCAL_YEAR);
      expect((dataSnapshot as { suppressReason?: string }).suppressReason).toBe('zero_balance');
    });
  });

  // ── Note 9 ────────────────────────────────────────────────────────────────

  describe('generateNote9Inventories', () => {
    it('suppresses with zero_balance when no inventory rows exist', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await generateNote9Inventories(COMPANY_ID, FISCAL_YEAR);
      expect(result.dataSnapshot).toHaveProperty('suppressReason', 'zero_balance');
      expect(result.content.title).toBe('Inventories');
      expect(mockSql).toHaveBeenCalled();
    });
  });

  // ── Note 10 ───────────────────────────────────────────────────────────────

  describe('generateNote10TradeReceivables', () => {
    const mockAged = vi.mocked(getAgedBucketTotals);

    it('asks the AR ageing for the fiscal year END, and prints its gross', async () => {
      mockAged.mockResolvedValueOnce({ current: 80000, days30: 25000, days60: 10000, days90: 3000, days120Plus: 2000, disputed: 0, gross: 120000 });
      const result = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      expect(mockAged).toHaveBeenCalledWith(COMPANY_ID, 'ar', '2026-12-31');
      const [summary] = result.content.blocks.filter((b) => b.type === 'table') as { rows: string[][] }[];
      expect(summary!.rows[0]).toEqual(['Gross trade receivables', '120\u00a0000,00']);
      expect(summary!.rows.some((r) => r[0] === 'Net trade receivables')).toBe(true);
      expect(result.dataSnapshot).toHaveProperty('receivables.0.gross_receivables', 120000);
    });

    it('the age table is the ageing\'s five buckets and foots to gross', async () => {
      mockAged.mockResolvedValueOnce({ current: 60000, days30: 20000, days60: 15000, days90: 3000, days120Plus: 2000, disputed: 0, gross: 100000 });
      const { content } = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.filter((b) => b.type === 'table')[1] as { headers: string[]; rows: string[][] };
      expect(table.headers).toEqual(['Current', '30 days', '60 days', '90 days', '120+ days', 'Total']);
      expect(table.rows[0]).toEqual(['60\u00a0000,00', '20\u00a0000,00', '15\u00a0000,00', '3\u00a0000,00', '2\u00a0000,00', '100\u00a0000,00']);
    });

    it('open disputes get their own column, so the row still foots', async () => {
      mockAged.mockResolvedValueOnce({ current: 400, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 600, gross: 1000 });
      const { content } = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.filter((b) => b.type === 'table')[1] as { headers: string[]; rows: string[][] };
      expect(table.headers).toEqual(['Current', '30 days', '60 days', '90 days', '120+ days', 'Disputed', 'Total']);
      expect(table.rows[0]![5]).toBe('600,00');
      expect(table.rows[0]![6]).toBe('1\u00a0000,00');
    });

    it('always includes both tables even when gross = 0', async () => {
      mockAged.mockResolvedValueOnce({ current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, gross: 0 });
      const { content } = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      expect(content.blocks.filter((b) => b.type === 'table')).toHaveLength(2);
    });
  });
});
