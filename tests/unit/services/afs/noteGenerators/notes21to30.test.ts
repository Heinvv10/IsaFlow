// tests/unit/services/afs/noteGenerators/notes21to30.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  generateNote21FinanceCosts,
  generateNote22EmployeeBenefits,
  generateNote23RelatedParties,
  generateNote24AuditorRemuneration,
  generateNote25ContingenciesAndCommitments,
  generateNote26EventsAfterReportingDate,
  generateNote27GoingConcern,
  generateNote28SegmentInformation,
  generateNote29FinancialInstrumentsRisk,
  generateNote30StandardsNotYetEffective,
} from '@/modules/accounting/services/afs/noteGenerators/notes21to30';

const COMPANY_ID = 'ccc-test-0000-0000-0000-000000000021';
const FISCAL_YEAR = 2025;
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

describe('notes21to30 generators', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─── Note 21 ─────────────────────────────────────────────────────────────

  describe('generateNote21FinanceCosts', () => {
    it('returns dataSnapshot and content when rows exist', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'FNB Interest', account_subtype: 'interest_expense', amount: 12000 },
        { account_name: 'Bank Charges', account_subtype: 'bank_charges', amount: 1500 },
      ]);

      const result = await generateNote21FinanceCosts(COMPANY_ID, FISCAL_YEAR);
      expect(result).toHaveProperty('dataSnapshot');
      expect(result).toHaveProperty('content');
      expect(result.content.title).toBe('Finance Costs');
    });

    it('includes table with correct headers when rows exist', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'Loan Interest', account_subtype: 'interest_expense', amount: 8000 },
      ]);

      const { content } = await generateNote21FinanceCosts(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.find((b) => b.type === 'table');
      expect(table).toBeDefined();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Description', 'Type', 'Amount']);
        // 1 data row + 1 total row
        expect(table.rows.length).toBe(2);
        expect(table.rows[table.rows.length - 1][0]).toBe('Total');
      }
    });

    it('suppresses (empty blocks) when no finance cost rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const { content } = await generateNote21FinanceCosts(COMPANY_ID, FISCAL_YEAR);
      expect(content.blocks).toHaveLength(0);
    });

    it('calls sql exactly once', async () => {
      sqlMock.mockResolvedValueOnce([]);
      await generateNote21FinanceCosts(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Note 22 ─────────────────────────────────────────────────────────────

  describe('generateNote22EmployeeBenefits', () => {
    it('returns dataSnapshot and content when rows exist', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_subtype: 'salaries', amount: 180000 },
        { account_subtype: 'uif', amount: 5000 },
      ]);

      const result = await generateNote22EmployeeBenefits(COMPANY_ID, FISCAL_YEAR);
      expect(result).toHaveProperty('dataSnapshot');
      expect(result).toHaveProperty('content');
      expect(result.content.title).toBe('Employee Benefits');
    });

    it('includes table with correct headers and total row', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_subtype: 'salaries', amount: 200000 },
        { account_subtype: 'medical_aid', amount: 15000 },
      ]);

      const { content } = await generateNote22EmployeeBenefits(COMPANY_ID, FISCAL_YEAR);
      const table = content.blocks.find((b) => b.type === 'table');
      expect(table).toBeDefined();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Benefit Type', 'Amount']);
        // 2 data rows + 1 total row
        expect(table.rows.length).toBe(3);
        expect(table.rows[table.rows.length - 1][0]).toBe('Total');
      }
    });

    it('suppresses when no employee benefit rows', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const { content } = await generateNote22EmployeeBenefits(COMPANY_ID, FISCAL_YEAR);
      expect(content.blocks).toHaveLength(0);
    });
  });

  // ─── Note 23 ─────────────────────────────────────────────────────────────

  describe('generateNote23RelatedParties', () => {
    it('returns placeholder without querying DB', async () => {
      const result = await generateNote23RelatedParties(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it('has suppressReason table_not_implemented', async () => {
      const result = await generateNote23RelatedParties(COMPANY_ID, FISCAL_YEAR);
      expect((result.dataSnapshot as { suppressReason?: string }).suppressReason).toBe('table_not_implemented');
    });

    it('has title Related Party Disclosures', async () => {
      const result = await generateNote23RelatedParties(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.title).toBe('Related Party Disclosures');
    });

    it('includes placeholder paragraph blocks', async () => {
      const result = await generateNote23RelatedParties(COMPANY_ID, FISCAL_YEAR);
      const paras = result.content.blocks.filter((b) => b.type === 'paragraph');
      expect(paras.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Note 24 ─────────────────────────────────────────────────────────────

  describe('generateNote24AuditorRemuneration', () => {
    it('returns table when audit fee rows exist', async () => {
      sqlMock.mockResolvedValueOnce([
        { account_name: 'Audit Fees', amount: 45000 },
      ]);

      const result = await generateNote24AuditorRemuneration(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.title).toBe('Auditor\'s Remuneration');
      const table = result.content.blocks.find((b) => b.type === 'table');
      expect(table).toBeDefined();
      if (table?.type === 'table') {
        expect(table.headers).toEqual(['Description', 'Amount']);
      }
    });

    it('returns placeholder paragraph when no audit fee rows (never suppress)', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote24AuditorRemuneration(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks.length).toBeGreaterThan(0);
      const para = result.content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeDefined();
      if (para?.type === 'paragraph') {
        expect(para.text).toContain('[Accountant:');
      }
    });

    it('calls sql exactly once', async () => {
      sqlMock.mockResolvedValueOnce([]);
      await generateNote24AuditorRemuneration(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Note 25 ─────────────────────────────────────────────────────────────

  describe('generateNote25ContingenciesAndCommitments', () => {
    it('returns placeholder without querying DB', async () => {
      const result = await generateNote25ContingenciesAndCommitments(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it('has title Contingencies and Commitments', async () => {
      const result = await generateNote25ContingenciesAndCommitments(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.title).toBe('Contingencies and Commitments');
    });

    it('has empty dataSnapshot', async () => {
      const result = await generateNote25ContingenciesAndCommitments(COMPANY_ID, FISCAL_YEAR);
      expect(result.dataSnapshot).toEqual({});
    });

    it('includes paragraph mentioning the fiscal year', async () => {
      const result = await generateNote25ContingenciesAndCommitments(COMPANY_ID, FISCAL_YEAR);
      const para = result.content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeDefined();
      if (para?.type === 'paragraph') {
        expect(para.text).toContain(String(FISCAL_YEAR));
      }
    });
  });

  // ─── Note 26 ─────────────────────────────────────────────────────────────

  describe('generateNote26EventsAfterReportingDate', () => {
    it('returns list block when post-period entries exist', async () => {
      sqlMock.mockResolvedValueOnce([
        { description: 'New loan agreement', entry_date: '2026-01-15', total_amount: 500000 },
      ]);

      const result = await generateNote26EventsAfterReportingDate(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.title).toBe('Events After Reporting Date');
      const list = result.content.blocks.find((b) => b.type === 'list');
      expect(list).toBeDefined();
    });

    it('always includes accountant placeholder paragraph', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote26EventsAfterReportingDate(COMPANY_ID, FISCAL_YEAR);
      const paras = result.content.blocks.filter((b) => b.type === 'paragraph');
      expect(paras.length).toBeGreaterThanOrEqual(1);
      const hasAccountant = paras.some(
        (p) => p.type === 'paragraph' && p.text.includes('[Accountant:'),
      );
      expect(hasAccountant).toBe(true);
    });

    it('calls sql exactly once', async () => {
      sqlMock.mockResolvedValueOnce([]);
      await generateNote26EventsAfterReportingDate(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Note 27 ─────────────────────────────────────────────────────────────

  describe('generateNote27GoingConcern', () => {
    it('runs two sql queries via Promise.all', async () => {
      sqlMock
        .mockResolvedValueOnce([{ current_assets: 500000, current_liabilities: 300000 }])
        .mockResolvedValueOnce([{ net_result: 120000 }]);

      await generateNote27GoingConcern(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).toHaveBeenCalledTimes(2);
    });

    it('includes current ratio and profit/loss in paragraph', async () => {
      sqlMock
        .mockResolvedValueOnce([{ current_assets: 600000, current_liabilities: 300000 }])
        .mockResolvedValueOnce([{ net_result: 50000 }]);

      const { content } = await generateNote27GoingConcern(COMPANY_ID, FISCAL_YEAR);
      const para = content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeDefined();
      if (para?.type === 'paragraph') {
        expect(para.text).toContain('2.00'); // ratio 600000/300000
      }
    });

    it('handles zero current liabilities (divide-by-zero) returning N/A', async () => {
      sqlMock
        .mockResolvedValueOnce([{ current_assets: 100000, current_liabilities: 0 }])
        .mockResolvedValueOnce([{ net_result: 20000 }]);

      const { content } = await generateNote27GoingConcern(COMPANY_ID, FISCAL_YEAR);
      const para = content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeDefined();
      if (para?.type === 'paragraph') {
        expect(para.text).toContain('N/A');
      }
    });

    it('flags concern when current ratio < 1.0', async () => {
      sqlMock
        .mockResolvedValueOnce([{ current_assets: 100000, current_liabilities: 200000 }])
        .mockResolvedValueOnce([{ net_result: -30000 }]);

      const { content } = await generateNote27GoingConcern(COMPANY_ID, FISCAL_YEAR);
      // Should have concern paragraph
      expect(content.blocks.length).toBeGreaterThanOrEqual(3);
    });

    it('never suppresses — mandatory note', async () => {
      sqlMock
        .mockResolvedValueOnce([{ current_assets: null, current_liabilities: null }])
        .mockResolvedValueOnce([{ net_result: null }]);

      const { content } = await generateNote27GoingConcern(COMPANY_ID, FISCAL_YEAR);
      expect(content.blocks.length).toBeGreaterThan(0);
    });
  });

  // ─── Note 28 ─────────────────────────────────────────────────────────────

  describe('generateNote28SegmentInformation', () => {
    it('returns placeholder without querying DB', async () => {
      const result = await generateNote28SegmentInformation(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it('has suppressReason not_applicable', async () => {
      const result = await generateNote28SegmentInformation(COMPANY_ID, FISCAL_YEAR);
      expect((result.dataSnapshot as { suppressReason?: string }).suppressReason).toBe('not_applicable');
    });

    it('has title Segment Information', async () => {
      const result = await generateNote28SegmentInformation(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.title).toBe('Segment Information');
    });
  });

  // ─── Note 29 ─────────────────────────────────────────────────────────────

  describe('generateNote29FinancialInstrumentsRisk', () => {
    it('includes credit risk and liquidity risk headings', async () => {
      sqlMock
        .mockResolvedValueOnce([]) // credit risk query
        .mockResolvedValueOnce([]); // liquidity risk query

      const result = await generateNote29FinancialInstrumentsRisk(COMPANY_ID, FISCAL_YEAR);
      const headings = result.content.blocks.filter((b) => b.type === 'heading');
      const headingTexts = headings.map((h) => (h.type === 'heading' ? h.text : ''));
      expect(headingTexts).toContain('Credit Risk');
      expect(headingTexts).toContain('Liquidity Risk');
    });

    it('runs two sql queries', async () => {
      sqlMock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await generateNote29FinancialInstrumentsRisk(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).toHaveBeenCalledTimes(2);
    });

    it('has title Financial Instruments Risk', async () => {
      sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const result = await generateNote29FinancialInstrumentsRisk(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.title).toBe('Financial Instruments Risk');
    });
  });

  // ─── Note 30 ─────────────────────────────────────────────────────────────

  describe('generateNote30StandardsNotYetEffective', () => {
    it('returns list block when new standards exist', async () => {
      sqlMock.mockResolvedValueOnce([
        {
          standard_reference: 'IFRS 18',
          title: 'Presentation and Disclosure in Financial Statements',
          effective_from: '2027-01-01',
          change_summary: 'Replaces IAS 1',
        },
      ]);

      const result = await generateNote30StandardsNotYetEffective(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.title).toBe('Standards Not Yet Effective');
      const list = result.content.blocks.find((b) => b.type === 'list');
      expect(list).toBeDefined();
      if (list?.type === 'list') {
        expect(list.items[0]).toContain('IFRS 18');
        expect(list.items[0]).toContain('effective');
      }
    });

    it('includes intro paragraph block', async () => {
      sqlMock.mockResolvedValueOnce([
        {
          standard_reference: 'IFRS 18',
          title: 'Presentation and Disclosure',
          effective_from: '2027-01-01',
          change_summary: 'Changes presentation',
        },
      ]);

      const { content } = await generateNote30StandardsNotYetEffective(COMPANY_ID, FISCAL_YEAR);
      const para = content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeDefined();
    });

    it('returns no-impact paragraph when no standards pending', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const { content } = await generateNote30StandardsNotYetEffective(COMPANY_ID, FISCAL_YEAR);
      const para = content.blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeDefined();
      if (para?.type === 'paragraph') {
        expect(para.text).toContain('No new IFRS standards');
      }
    });

    it('never suppresses — mandatory', async () => {
      sqlMock.mockResolvedValueOnce([]);
      const result = await generateNote30StandardsNotYetEffective(COMPANY_ID, FISCAL_YEAR);
      expect(result.content.blocks.length).toBeGreaterThan(0);
    });

    it('calls sql exactly once', async () => {
      sqlMock.mockResolvedValueOnce([]);
      await generateNote30StandardsNotYetEffective(COMPANY_ID, FISCAL_YEAR);
      expect(sqlMock).toHaveBeenCalledTimes(1);
    });
  });
});
