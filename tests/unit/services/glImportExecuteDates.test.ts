/**
 * Day-first dates on the GL import's POSTING path (importJournalEntries), split
 * out of glImportExecute.test.ts. The preview path is pinned in
 * tests/unit/services/gl/glImportDateNormalise.test.ts.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn().mockResolvedValue({ status: 'posted' }),
}));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { importJournalEntries } from '@/modules/accounting/services/gl/glImportExecuteService';
import type { ImportRow } from '@/modules/accounting/services/gl/glImportService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const createMock = createJournalEntry as unknown as MockedFunction<(...a: unknown[]) => Promise<{ id: string }>>;

/** The chart the service resolves codes against; every other read answers empty. */
function withAccounts(codes: Record<string, string>) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM gl_accounts')) {
      return Promise.resolve(Object.entries(codes).map(([account_code, id]) => ({ account_code, id })));
    }
    return Promise.resolve([]);
  }) as never);
}

const ACCOUNTS = { '1000': 'acct-bank', '4000': 'acct-sales' };
const row = (over: Partial<ImportRow>): ImportRow => ({
  date: '2026-08-13', accountCode: '1000', description: 'test', reference: 'REF1', debit: 0, credit: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  createMock.mockImplementation(async () => ({ id: `je-${++n}` }));
});

// The posting path, not only the preview: a South African file's 03/04/2026 is
// 3 April. Unnormalised it reached createJournalEntry (and Postgres, whose
// default DateStyle is month-first) as the raw string, and two spellings of one
// day became two journals.
describe('importJournalEntries — day-first dates on the posting path', () => {
  it('posts a dd/mm/yyyy row on the ISO day, day first', async () => {
    withAccounts(ACCOUNTS);
    await importJournalEntries(COMPANY, [
      row({ date: '03/04/2026', accountCode: '1000', debit: 100, credit: 0 }),
      row({ date: '03/04/2026', accountCode: '4000', debit: 0, credit: 100 }),
    ], USER, false);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect((createMock.mock.calls[0]![1] as { entryDate: string }).entryDate).toBe('2026-04-03');
  });

  it('groups two spellings of the same day into one journal', async () => {
    withAccounts(ACCOUNTS);
    await importJournalEntries(COMPANY, [
      row({ date: '03/04/2026', accountCode: '1000', debit: 100, credit: 0 }),
      row({ date: '2026-04-03', accountCode: '4000', debit: 0, credit: 100 }),
    ], USER, false);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect((createMock.mock.calls[0]![1] as { entryDate: string }).entryDate).toBe('2026-04-03');
  });
});
