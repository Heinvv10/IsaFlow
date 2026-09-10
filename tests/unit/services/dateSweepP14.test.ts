/**
 * P1.4 date sweep — regression pins for the UTC+2 rollback family.
 *
 * pg returns DATE columns as JS Date objects at LOCAL midnight; on this
 * UTC+2 server, toISOString() converts to the PREVIOUS day at 22:00 UTC.
 * Every serialization of a DB-sourced date must go through fmtDate
 * (local getters) — this file pins the highest-consequence sites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// These tests discriminate fmtDate (local getters) from the buggy
// toISOString path ONLY when the process runs ahead of UTC. Pin the zone and
// fail loudly if the runner ignores it — a UTC runner would make the old
// buggy code pass these tests silently.
process.env.TZ = 'Africa/Johannesburg';

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    ...original, // REAL fmtDate — the behavior under test must not be mocked
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
  postJournalEntry: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acct-1' }),
}));

import { toISODate as archiveToISODate } from '@/modules/accounting/services/core/archiveQueryService';
import { toISODate as dunningToISODate } from '@/modules/accounting/services/ar/dunningService';

describe('P1.4 date sweep (UTC+2 rollback family)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runner timezone is ahead of UTC (guard — see header comment)', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBeLessThan(0);
  });

  // N4 actual invoice date/journal linkage is arCiPosting.int.test.ts (AR02).

  it('archiveQueryService.toISODate returns the local date for pg Date values', () => {
    expect(archiveToISODate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('dunningService.toISODate returns the local date for pg Date values', () => {
    expect(dunningToISODate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});
