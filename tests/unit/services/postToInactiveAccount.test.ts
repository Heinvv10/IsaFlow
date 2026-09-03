/**
 * A journal cannot be posted to a deactivated GL account.
 *
 * This closes a sequence the balance guard on `updateAccount` cannot see:
 *
 *   1. an account's only lines are drafts, so its posted balance is 0
 *   2. deactivating it is therefore allowed, and correctly so
 *   3. someone posts that draft later
 *   4. the account is now inactive AND holds a balance — exactly the state
 *      the guard exists to prevent, reached without ever touching the guard
 *
 * The refusal is also right on its own merits. `is_active = false` means the
 * account has been withdrawn from the chart and is no longer offered when
 * coding new transactions; accepting a fresh posting to it contradicts that.
 *
 * Whole-entry refusal, never a skipped line: a partially-posted journal does
 * not balance, and this repo's convention is that a refusal happens BEFORE the
 * write so the transaction commits nothing (the 400-after-write defect class).
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }),
  withTransaction: vi.fn(),
  withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const getJournalEntryById = vi.fn();
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  getJournalEntryById: (...a: unknown[]) => getJournalEntryById(...(a as [])),
  createJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn(async (u: string) => u),
  mapEntryRow: (r: Record<string, unknown>) => ({ id: String(r.id), status: String(r.status) }),
}));

import { postJournalEntry, InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTRY = 'cccccccc-0000-0000-0000-000000000001';
const USER = 'dddddddd-0000-0000-0000-000000000001';

const DRAFT_ENTRY = {
  id: ENTRY,
  status: 'draft',
  fiscalPeriodId: null,
  lines: [
    { glAccountId: 'acct-1', debit: 130000, credit: 0 },
    { glAccountId: 'acct-2', debit: 0, credit: 130000 },
  ],
};

/** Joined template text with SQL comments stripped. */
function texts(): string[] {
  return sqlMock.mock.calls.map((c) =>
    (c[0] as readonly string[]).join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' '),
  );
}

const postWrites = () => texts().filter((q) => /UPDATE gl_journal_entries/i.test(q));

/** `inactive` is the set of deactivated accounts the entry's lines touch. */
function seed(inactive: { account_code: string; account_name: string }[]) {
  sqlMock.mockReset();
  getJournalEntryById.mockResolvedValue(DRAFT_ENTRY);
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join(' ');
    if (/is_active = false/i.test(q)) return inactive;
    if (/UPDATE gl_journal_entries/i.test(q)) return [{ id: ENTRY, status: 'posted', entry_number: 'JE-1' }];
    return [];
  });
}

beforeEach(() => seed([]));

describe('postJournalEntry refuses a deactivated account', () => {
  it('throws InactiveAccountError naming the account', async () => {
    seed([{ account_code: '1121', account_name: 'Loan Account - Blitz Fibre' }]);

    await expect(postJournalEntry(COMPANY, ENTRY, USER)).rejects.toThrow(InactiveAccountError);
    await expect(postJournalEntry(COMPANY, ENTRY, USER)).rejects.toThrow(/1121/);
    await expect(postJournalEntry(COMPANY, ENTRY, USER)).rejects.toThrow(/Loan Account - Blitz Fibre/);
  });

  it('tells the user what to do about it', async () => {
    seed([{ account_code: '1121', account_name: 'Loan Account - Blitz Fibre' }]);

    await expect(postJournalEntry(COMPANY, ENTRY, USER)).rejects.toThrow(/reactivate|recode/i);
  });

  it('refuses the WHOLE entry and writes nothing — never posts the good lines', async () => {
    seed([{ account_code: '1121', account_name: 'Loan Account - Blitz Fibre' }]);

    await expect(postJournalEntry(COMPANY, ENTRY, USER)).rejects.toThrow();
    expect(postWrites()).toHaveLength(0);
  });

  it('names every offending account, not just the first', async () => {
    seed([
      { account_code: '1121', account_name: 'Loan Account - Blitz Fibre' },
      { account_code: '5820', account_name: 'Other Expense' },
    ]);

    const err = await postJournalEntry(COMPANY, ENTRY, USER).catch((e: Error) => e);
    expect(err.message).toMatch(/1121/);
    expect(err.message).toMatch(/5820/);
  });

  it('posts normally when every account is active', async () => {
    seed([]);

    await expect(postJournalEntry(COMPANY, ENTRY, USER)).resolves.toMatchObject({ status: 'posted' });
    expect(postWrites()).toHaveLength(1);
  });

  it('scopes the account check by company and to this entry only', async () => {
    seed([]);
    await postJournalEntry(COMPANY, ENTRY, USER);

    const [q] = texts().filter((t) => /is_active = false/i.test(t));
    expect(q).toBeDefined();
    expect(q!).toMatch(/jl\.journal_entry_id = \?/);
    expect(q!).toMatch(/jl\.company_id = \?/);
    expect(q!).toMatch(/ga\.company_id = jl\.company_id/);
  });

  it('is an instanceof-matchable error, like ClosedFiscalPeriodError', async () => {
    seed([{ account_code: '1121', account_name: 'Loan Account - Blitz Fibre' }]);

    const err = await postJournalEntry(COMPANY, ENTRY, USER).catch((e: unknown) => e);
    // Automated posters (bank-rules auto-post) match on instanceof rather than
    // regexing the message, so wording changes cannot silently move the
    // swallow/re-throw boundary.
    expect(err).toBeInstanceOf(InactiveAccountError);
    expect((err as InactiveAccountError).accounts).toEqual(['1121']);
  });
});
