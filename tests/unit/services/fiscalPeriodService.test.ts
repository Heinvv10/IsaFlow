/**
 * Unit tests for fiscalPeriodService — getCurrentOpenPeriod
 *
 * Covers:
 * 1. Today falls inside an open period → returns that period.
 * 2. Today falls inside a closed period → falls back to most recent open period.
 * 3. Today is after all open periods → falls back to most recent open period.
 * 4. No open periods exist at all → returns null.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getCurrentOpenPeriod } from '@/modules/accounting/services/gl/fiscalPeriodService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Build a minimal raw DB row for mapRow to consume */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'period-id-1',
    period_name: 'January 2026',
    period_number: 1,
    fiscal_year: 2026,
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    status: 'open',
    closed_by: null,
    closed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('getCurrentOpenPeriod', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the open period containing today when one exists', async () => {
    const row = makeRow({ id: 'today-period', period_name: 'April 2026', status: 'open' });

    // First SQL call (today inside open period) → returns a row
    mockSql.mockResolvedValueOnce([row]);

    const result = await getCurrentOpenPeriod(COMPANY_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('today-period');
    // Only one SQL call should have been made
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('passes company_id as the first interpolated argument (multi-tenant safety)', async () => {
    const row = makeRow({ id: 'today-period', status: 'open' });
    mockSql.mockResolvedValueOnce([row]);

    await getCurrentOpenPeriod(COMPANY_ID);

    // The first sql call's second element (interpolated args[0]) must be the company_id.
    // This guards against SQL injection by ensuring tenant scope is always parameterised.
    const firstCallArgs = mockSql.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
    // sql tagged template: args[0] is the TemplateStringsArray, args[1..] are interpolated values
    expect(firstCallArgs![1]).toBe(COMPANY_ID);
  });

  it('passes company_id in the fallback SQL call as well', async () => {
    const fallbackRow = makeRow({ id: 'fallback-period', status: 'open' });
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([fallbackRow]);

    await getCurrentOpenPeriod(COMPANY_ID);

    expect(mockSql).toHaveBeenCalledTimes(2);
    // Both calls must carry company_id
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_ID);
    expect(mockSql.mock.calls[1]![1]).toBe(COMPANY_ID);
  });

  it('falls back to most recent open period when today is inside a closed period', async () => {
    const fallbackRow = makeRow({
      id: 'fallback-period',
      period_name: 'March 2026',
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      status: 'open',
    });

    // First SQL call (today inside open): no match (today is in a closed period)
    mockSql.mockResolvedValueOnce([]);
    // Second SQL call (most recent open): returns fallback
    mockSql.mockResolvedValueOnce([fallbackRow]);

    const result = await getCurrentOpenPeriod(COMPANY_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('fallback-period');
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('falls back to most recent open period when today is after all open periods', async () => {
    const futureRow = makeRow({
      id: 'future-period',
      period_name: 'January 2027',
      start_date: '2027-01-01',
      end_date: '2027-01-31',
      status: 'open',
    });

    // First SQL call (today inside open): no match
    mockSql.mockResolvedValueOnce([]);
    // Second SQL call (most recent open): returns the future demo period
    mockSql.mockResolvedValueOnce([futureRow]);

    const result = await getCurrentOpenPeriod(COMPANY_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('future-period');
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns null when no open periods exist at all', async () => {
    // Both SQL calls return empty
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const result = await getCurrentOpenPeriod(COMPANY_ID);

    expect(result).toBeNull();
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
