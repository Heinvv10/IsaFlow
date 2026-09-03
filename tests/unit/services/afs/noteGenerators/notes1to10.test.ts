import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
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

import { sql } from '@/lib/neon';
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
    it('returns dataSnapshot and content', async () => {
      mockSql.mockResolvedValueOnce([
        {
          gross_receivables: '120000',
          current_amount: '80000',
          days_30: '25000',
          days_60: '10000',
          days_90_plus: '5000',
        },
      ]);
      const result = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      expect(result).toHaveProperty('dataSnapshot');
      expect(result).toHaveProperty('content');
    });

    it('content includes two table blocks', async () => {
      mockSql.mockResolvedValueOnce([
        {
          gross_receivables: '100000',
          current_amount: '60000',
          days_30: '20000',
          days_60: '15000',
          days_90_plus: '5000',
        },
      ]);
      const { content } = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      const tables = content.blocks.filter((b) => b.type === 'table');
      expect(tables.length).toBe(2);
    });

    it('first table has net receivables row', async () => {
      mockSql.mockResolvedValueOnce([
        {
          gross_receivables: '50000',
          current_amount: '30000',
          days_30: '10000',
          days_60: '5000',
          days_90_plus: '5000',
        },
      ]);
      const { content } = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.filter((b) => b.type === 'table')[0] as {
        type: 'table';
        headers: string[];
        rows: string[][];
      };
      expect(table.rows.some((r) => r[0] === 'Net trade receivables')).toBe(true);
    });

    it('second table has aging headers', async () => {
      mockSql.mockResolvedValueOnce([
        {
          gross_receivables: '0',
          current_amount: '0',
          days_30: '0',
          days_60: '0',
          days_90_plus: '0',
        },
      ]);
      const { content } = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.filter((b) => b.type === 'table')[1] as {
        type: 'table';
        headers: string[];
        rows: string[][];
      };
      expect(table.headers).toEqual(['Current', '30 days', '60 days', '90+ days', 'Total']);
    });

    it('always includes both tables even when gross = 0', async () => {
      mockSql.mockResolvedValueOnce([
        {
          gross_receivables: null,
          current_amount: null,
          days_30: null,
          days_60: null,
          days_90_plus: null,
        },
      ]);
      const { content } = await generateNote10TradeReceivables(COMPANY_ID, FISCAL_YEAR);
      const tables = content.blocks.filter((b) => b.type === 'table');
      expect(tables.length).toBe(2);
    });
  });
});
