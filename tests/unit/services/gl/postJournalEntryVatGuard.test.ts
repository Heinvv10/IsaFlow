/**
 * postJournalEntry's VAT-lock contract, as call ORDER — the guard itself is a
 * spy here, so this file goes red if the call is removed or moved.
 *
 *   1. The draft's header row is locked FOR UPDATE before anything is read, so
 *      a concurrent edit of its date cannot land between the guard and the
 *      status UPDATE.
 *   2. assertJournalVatPeriodOpen runs with the entry's date and lines, after
 *      the lock and BEFORE the status UPDATE.
 *   3. A refusal from the guard writes nothing.
 *
 * The guard's own behaviour against a real ledger:
 * tests/integration/vat-period-lock-posting.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn((strings: readonly string[]) => {
    const text = strings.join('?');
    h.log.push(/FOR UPDATE/.test(text) ? 'lock-row' : /SET status = 'posted'/.test(text) ? 'update-posted'
      : /FROM fiscal_periods/.test(text) ? 'period' : 'other-sql');
    if (/FROM fiscal_periods/.test(text)) return Promise.resolve([{ status: 'open' }]);
    if (/SET status = 'posted'/.test(text)) return Promise.resolve([{ id: 'je-1', entry_number: 'JE-1' }]);
    return Promise.resolve([{ id: 'je-1' }]);
  }), { transaction: vi.fn(), unsafe: vi.fn() }),
  withTransaction: vi.fn(),
  withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
}));

const LINES = [
  { glAccountId: 'acc-exp', debit: 100, credit: 0 },
  { glAccountId: 'acc-vat', debit: 15, credit: 0, vatType: 'standard' },
  { glAccountId: 'acc-ap', debit: 0, credit: 115 },
];

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  getJournalEntryById: vi.fn(async () => {
    h.log.push('read-entry');
    return { id: 'je-1', status: 'draft', entryDate: '2026-06-10', fiscalPeriodId: 'fp-1', lines: LINES };
  }),
  createJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn(async (u: string) => u),
  mapEntryRow: vi.fn((r: unknown) => r),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/journalEntryPostingGuards')>()),
  assertNoInactiveAccountLines: vi.fn(async () => { h.log.push('inactive-check'); }),
}));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/journalVatLockGuard')>()),
  assertJournalVatPeriodOpen: vi.fn(async () => { h.log.push('vat-guard'); }),
}));

import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import {
  assertJournalVatPeriodOpen, VatPeriodLockedError,
} from '@/modules/accounting/services/gl/journalVatLockGuard';

const CO = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  h.log.length = 0;
  vi.mocked(assertJournalVatPeriodOpen).mockClear();
});

describe('postJournalEntry — VAT period lock', () => {
  it('locks the header row first, runs the guard with the entry date and lines, then posts', async () => {
    await postJournalEntry(CO, 'je-1', USER);

    expect(assertJournalVatPeriodOpen).toHaveBeenCalledTimes(1);
    expect(assertJournalVatPeriodOpen).toHaveBeenCalledWith(CO, '2026-06-10', LINES);

    const at = (step: string) => h.log.indexOf(step);
    expect(at('lock-row')).toBe(0);
    expect(at('lock-row')).toBeLessThan(at('read-entry'));
    expect(at('vat-guard')).toBeGreaterThan(at('read-entry'));
    expect(at('vat-guard')).toBeLessThan(at('update-posted'));
  });

  it('writes nothing when the guard refuses', async () => {
    vi.mocked(assertJournalVatPeriodOpen).mockImplementationOnce(async () => {
      throw new VatPeriodLockedError('2026-06-10', { id: 'l', periodStart: '2026-05-01', periodEnd: '2026-06-30' });
    });
    await expect(postJournalEntry(CO, 'je-1', USER)).rejects.toBeInstanceOf(VatPeriodLockedError);
    expect(h.log).not.toContain('update-posted');
  });
});
