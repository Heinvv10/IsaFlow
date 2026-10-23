/**
 * The GL import parsed user dates with `new Date(str)`, which reads 03/04/2026
 * month-first (4 March), and handed the raw string to Postgres, whose default
 * DateStyle does the same. South African files are day-first. Rows are now
 * normalised to ISO before either sees them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalDateGuard', () => ({
  ledgerDaysOf: vi.fn(async (dates: string[]) => new Map(dates.map(d => [d, d]))),
}));

import { ledgerDaysOf } from '@/modules/accounting/services/gl/journalDateGuard';
import { validateImportRows, type ImportRow } from '@/modules/accounting/services/gl/glImportService';

const row = (date: string): ImportRow => ({ date, accountCode: '1000', description: 'x', debit: 1, credit: 0 });

beforeEach(() => vi.clearAllMocks());

describe('validateImportRows — dates', () => {
  it('reads dd/mm/yyyy day-first and checks the ISO day', async () => {
    await validateImportRows('co', [row('03/04/2026')]);
    expect(vi.mocked(ledgerDaysOf).mock.calls[0]![0]).toEqual(['2026-04-03']);
  });

  it('still refuses a date it cannot read', async () => {
    const res = await validateImportRows('co', [row('31/02/2026')]);
    expect(res.validations[0]!.errors.some(e => e.includes('Invalid date'))).toBe(true);
  });
});
