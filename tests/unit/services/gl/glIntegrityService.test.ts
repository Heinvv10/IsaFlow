/**
 * Unit tests for glIntegrityService.findOrphanJournalEntries.
 *
 * Coverage:
 *  1. Returns count=0 with empty entries when no orphans.
 *  2. Returns count + earliest + latest + mapped entries when orphans exist.
 *  3. company_id is the first interpolated arg on both SQL calls.
 *  4. Tenant isolation — different companyId routed through to SQL.
 *  5. limit is honoured (clamped via service signature default).
 *  6. NULL description → empty string in returned entry.
 *  7. Skips the second SQL query entirely when count=0 (avoids needless round-trip).
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { findOrphanJournalEntries } from '@/modules/accounting/services/gl/glIntegrityService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeEach(() => {
  mockSql.mockReset();
});

describe('findOrphanJournalEntries', () => {
  it('returns count=0 with no entries when nothing is orphan', async () => {
    mockSql.mockResolvedValueOnce([{ count: 0, earliest: null, latest: null }]);

    const result = await findOrphanJournalEntries(COMPANY_A);

    expect(result).toEqual({ count: 0, earliest: null, latest: null, entries: [] });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns full payload with entries when orphans exist', async () => {
    mockSql
      .mockResolvedValueOnce([{ count: 5, earliest: '2022-07-19', latest: '2022-12-31' }])
      .mockResolvedValueOnce([
        {
          id: 'je-1',
          entry_date: '2022-07-19',
          status: 'posted',
          source: 'auto_bank_recon',
          description: 'Bank: Hvv Salary',
          created_at: '2026-05-01T05:55:00Z',
        },
        {
          id: 'je-2',
          entry_date: '2022-12-31',
          status: 'posted',
          source: 'auto_bank_recon',
          description: 'Bank: H van Vuuren Salary',
          created_at: '2026-05-01T05:55:00Z',
        },
      ]);

    const result = await findOrphanJournalEntries(COMPANY_A);

    expect(result.count).toBe(5);
    expect(result.earliest).toBe('2022-07-19');
    expect(result.latest).toBe('2022-12-31');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      id: 'je-1',
      entryDate: '2022-07-19',
      status: 'posted',
      source: 'auto_bank_recon',
      description: 'Bank: Hvv Salary',
      createdAt: '2026-05-01T05:55:00Z',
    });
  });

  it('passes companyId as the first interpolated arg on both calls', async () => {
    mockSql
      .mockResolvedValueOnce([{ count: 1, earliest: '2022-01-01', latest: '2022-01-01' }])
      .mockResolvedValueOnce([
        { id: 'je-1', entry_date: '2022-01-01', status: 'posted', source: 'manual', description: 'x', created_at: '2026-01-01T00:00:00Z' },
      ]);

    await findOrphanJournalEntries(COMPANY_A);

    // Each call into the tagged-template mock receives [strings, ...values]; companyId is the first value.
    const summaryCall = mockSql.mock.calls[0]!;
    const entriesCall = mockSql.mock.calls[1]!;
    expect(summaryCall[1]).toBe(COMPANY_A);
    expect(entriesCall[1]).toBe(COMPANY_A);
  });

  it('routes a different companyId through to SQL (tenant isolation)', async () => {
    mockSql.mockResolvedValueOnce([{ count: 0, earliest: null, latest: null }]);

    await findOrphanJournalEntries(COMPANY_B);

    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_B);
  });

  it('honours a custom limit on the entries query', async () => {
    mockSql
      .mockResolvedValueOnce([{ count: 50, earliest: '2022-01-01', latest: '2022-12-31' }])
      .mockResolvedValueOnce([]);

    await findOrphanJournalEntries(COMPANY_A, 25);

    // The entries call receives [strings, companyId, limit]
    const entriesCall = mockSql.mock.calls[1]!;
    expect(entriesCall[2]).toBe(25);
  });

  it('coerces NULL description to empty string', async () => {
    mockSql
      .mockResolvedValueOnce([{ count: 1, earliest: '2022-01-01', latest: '2022-01-01' }])
      .mockResolvedValueOnce([
        { id: 'je-1', entry_date: '2022-01-01', status: 'posted', source: 'manual', description: null, created_at: '2026-01-01T00:00:00Z' },
      ]);

    const result = await findOrphanJournalEntries(COMPANY_A);

    expect(result.entries[0]!.description).toBe('');
  });

  it('skips the entries query when count is zero (no needless round-trip)', async () => {
    mockSql.mockResolvedValueOnce([{ count: 0, earliest: null, latest: null }]);

    await findOrphanJournalEntries(COMPANY_A);

    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
