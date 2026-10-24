// tests/unit/services/afs/pisCalculatorService.test.ts
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// The document's year is the registry's stored year, not a range rebuilt from the start month.
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());

import { sql } from '@/lib/neon';
import { computePisScore, computePisScoreForDocument } from '@/modules/accounting/services/afs/pisCalculatorService';
import { fakeRegistry, resetFakeRegistry, TRANSITION_YEARS } from '../../../helpers/fiscalYearSqlFake';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('pisCalculatorService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes PIS correctly from GL data', async () => {
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '5000000' }])
      .mockResolvedValueOnce([{ total_liabilities: '2000000' }])
      .mockResolvedValueOnce([{ emp_begin: 0, emp_end: 0, sh_count: 0, all_dirs: false }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.turnoverPoints).toBe(5);
    expect(result.liabilityPoints).toBe(2);
    expect(result.employeePoints).toBe(0);
    expect(result.shareholderPoints).toBe(0);
    expect(result.total).toBe(7);
    expect(result.requiredFramework).toBe('ifrs_smes');
    // Conservative default: all_shareholders_are_directors is stubbed false
    expect(result.requiredAudit).toBe('independent_review');
    expect(result.requiredCipcFiling).toBe('afs_required');
  });

  it('PIS >= 350 triggers full IFRS and mandatory audit', async () => {
    // 200M revenue + 150M liabilities = 350 PIS
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '200000000' }])
      .mockResolvedValueOnce([{ total_liabilities: '150000000' }])
      .mockResolvedValueOnce([{ emp_begin: 0, emp_end: 0, sh_count: 0, all_dirs: false }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.total).toBe(350);
    expect(result.requiredFramework).toBe('full_ifrs');
    expect(result.requiredAudit).toBe('mandatory_audit');
    expect(result.requiredCipcFiling).toBe('afs_required');
  });

  it('PIS < 100 defaults to independent_review (conservative stub)', async () => {
    // 50M revenue + 10M liabilities = 60 PIS
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '50000000' }])
      .mockResolvedValueOnce([{ total_liabilities: '10000000' }])
      .mockResolvedValueOnce([{ emp_begin: 0, emp_end: 0, sh_count: 0, all_dirs: false }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.total).toBe(60);
    // Should NOT be 'voluntary' because all_shareholders_are_directors is stubbed false
    expect(result.requiredAudit).toBe('independent_review');
    expect(result.requiredCipcFiling).toBe('afs_required');
  });

  it('rounds GL figures to 2 decimal places', async () => {
    // 1_500_500 / 1_000_000 = 1.5005 → rounds to 1.5
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '1500500' }])
      .mockResolvedValueOnce([{ total_liabilities: '0' }])
      .mockResolvedValueOnce([{ emp_begin: 0, emp_end: 0, sh_count: 0, all_dirs: false }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.turnoverPoints).toBe(1.5);
  });

  it('returns zero points when GL is empty', async () => {
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '0' }])
      .mockResolvedValueOnce([{ total_liabilities: '0' }])
      .mockResolvedValueOnce([{ emp_begin: 0, emp_end: 0, sh_count: 0, all_dirs: false }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.turnoverPoints).toBe(0);
    expect(result.liabilityPoints).toBe(0);
    expect(result.total).toBe(0);
  });

  it('dataUnavailable always includes stubbed fields', async () => {
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '0' }])
      .mockResolvedValueOnce([{ total_liabilities: '0' }])
      .mockResolvedValueOnce([{ emp_begin: 0, emp_end: 0, sh_count: 0, all_dirs: false }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.dataUnavailable).toContain('employee_count');
    expect(result.dataUnavailable).toContain('shareholder_count');
  });
});

describe('computePisScoreForDocument — the document\'s year comes from the registry', () => {
  beforeEach(() => { vi.clearAllMocks(); resetFakeRegistry(); });

  const primeGl = () => mockSql
    .mockResolvedValueOnce([{ total_revenue: '5000000' }])
    .mockResolvedValueOnce([{ total_liabilities: '2000000' }])
    .mockResolvedValueOnce([{ emp_begin: 0, emp_end: 0, sh_count: 0, all_dirs: false }]);

  it('measures a March year over its stored dates', async () => {
    mockSql.mockResolvedValueOnce([{ fiscal_year: 2026 }]);
    primeGl();
    await computePisScoreForDocument(COMPANY, 'doc-1');
    const revenueArgs = mockSql.mock.calls[1]!.slice(1);
    expect(revenueArgs).toContain('2025-03-01');
    expect(revenueArgs).toContain('2026-02-28');
  });

  it('measures a 14-month transition year over all fourteen months', async () => {
    fakeRegistry.years = TRANSITION_YEARS;
    mockSql.mockResolvedValueOnce([{ fiscal_year: 2027 }]);
    primeGl();
    await computePisScoreForDocument(COMPANY, 'doc-1');
    const revenueArgs = mockSql.mock.calls[1]!.slice(1);
    expect(revenueArgs).toContain('2026-01-01');
    expect(revenueArgs).toContain('2027-02-28');
  });

  it('never reads the declared start month from the companies row', async () => {
    mockSql.mockResolvedValueOnce([{ fiscal_year: 2026 }]);
    primeGl();
    await computePisScoreForDocument(COMPANY, 'doc-1');
    const first = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(first).not.toContain('financial_year_start');
  });

  it('refuses a document that is not this company\'s', async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(computePisScoreForDocument(COMPANY, 'doc-x')).rejects.toThrow(/not found/);
  });
});
