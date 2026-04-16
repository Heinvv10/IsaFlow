// tests/unit/services/afs/pisCalculatorService.test.ts
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { computePisScore } from '@/modules/accounting/services/afs/pisCalculatorService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('pisCalculatorService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes PIS correctly from GL data', async () => {
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '5000000' }])
      .mockResolvedValueOnce([{ total_liabilities: '2000000' }]);

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
      .mockResolvedValueOnce([{ total_liabilities: '150000000' }]);

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
      .mockResolvedValueOnce([{ total_liabilities: '10000000' }]);

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
      .mockResolvedValueOnce([{ total_liabilities: '0' }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.turnoverPoints).toBe(1.5);
  });

  it('returns zero points when GL is empty', async () => {
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '0' }])
      .mockResolvedValueOnce([{ total_liabilities: '0' }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.turnoverPoints).toBe(0);
    expect(result.liabilityPoints).toBe(0);
    expect(result.total).toBe(0);
  });

  it('dataUnavailable always includes stubbed fields', async () => {
    mockSql
      .mockResolvedValueOnce([{ total_revenue: '0' }])
      .mockResolvedValueOnce([{ total_liabilities: '0' }]);

    const result = await computePisScore(COMPANY, '2025-03-01', '2026-02-28');

    expect(result.dataUnavailable).toContain('employee_count');
    expect(result.dataUnavailable).toContain('shareholder_count');
  });
});
