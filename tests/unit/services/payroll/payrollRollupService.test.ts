import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- SQL mock ---
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);
const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import { getAnnualPayrollEstimate } from '@/modules/accounting/services/payroll/payrollRollupService';

const companyId = 'aabbccdd-0000-0000-0000-000000000001';

beforeEach(() => {
  mockImpl = () => Promise.resolve([]);
  sqlCalls.length = 0;
});

describe('getAnnualPayrollEstimate', () => {
  it('returns 0 when no history exists', async () => {
    mockImpl = () => Promise.resolve([]);
    const result = await getAnnualPayrollEstimate(companyId, { month: 3, year: 2025 });
    expect(result).toBe(0);
  });

  it('returns sum when 12 months of history exist', async () => {
    const rows = Array.from({ length: 12 }, () => ({ total_gross: '10000' }));
    mockImpl = () => Promise.resolve(rows);
    const result = await getAnnualPayrollEstimate(companyId, { month: 3, year: 2025 });
    expect(result).toBe(120000);
  });

  it('extrapolates proportionally when fewer months exist', async () => {
    // 6 rows × 10000 = 60000 sum; extrapolated: (60000 / 6) * 12 = 120000
    const rows = Array.from({ length: 6 }, () => ({ total_gross: '10000' }));
    mockImpl = () => Promise.resolve(rows);
    const result = await getAnnualPayrollEstimate(companyId, { month: 3, year: 2025 });
    expect(result).toBe(120000);
  });

  it('rounds to 2dp', async () => {
    // 1 row with total_gross that yields a non-integer extrapolation
    // sum = 1028.806, months = 1 → extrapolated = 1028.806 * 12 = 12345.672 → rounded to 12345.67
    const rows = [{ total_gross: '1028.806' }];
    mockImpl = () => Promise.resolve(rows);
    const result = await getAnnualPayrollEstimate(companyId, { month: 3, year: 2025 });
    expect(result).toBe(12345.67);
  });

  it('filters out cancelled runs — SQL contains correct status filter', async () => {
    mockImpl = () => Promise.resolve([]);
    await getAnnualPayrollEstimate(companyId, { month: 3, year: 2025 });
    expect(sqlCalls.length).toBeGreaterThan(0);
    const lastCall = sqlCalls[sqlCalls.length - 1]!;
    expect(lastCall.sql).toContain("'calculated', 'approved', 'paid'");
  });

  it('window is inclusive on both ends — given Mar 2025, earliest key is 202404 (Apr 2024)', async () => {
    mockImpl = () => Promise.resolve([]);
    await getAnnualPayrollEstimate(companyId, { month: 3, year: 2025 });
    expect(sqlCalls.length).toBeGreaterThan(0);
    const lastCall = sqlCalls[sqlCalls.length - 1]!;
    // earliestKey = Apr 2024 → 2024 * 100 + 4 = 202404
    expect(lastCall.values).toContain(202404);
    // latestKey = Mar 2025 → 2025 * 100 + 3 = 202503
    expect(lastCall.values).toContain(202503);
  });
});
