/**
 * Legacy GL draft staging must validate complete balanced groups.
 * Actual approved posting and rollback are covered by historicalImportExecution.int.test.ts.
 *
 * importJournalEntries groups rows by date+reference, one journal per group.
 * The old body INSERTed each group's header directly (status='posted' when the
 * caller asked to post immediately), then looped the rows inserting lines. Two
 * defects:
 *
 *   1. `if (!accountId) continue;` — a row whose account code did not resolve
 *      was skipped and the REST of the group still posted, silently dropping
 *      that row's debit or credit. The comment claimed "already validated
 *      upstream", but validation runs in the preview endpoint, which the
 *      execute path does not require the caller to have called.
 *   2. Nothing re-checked that a group balanced at write time. The header went
 *      in already 'posted', and trg_gl_je_balanced only fires on UPDATE.
 *
 * Combined: an import containing one unmapped account code posted an entry
 * short by that row's amount. And `source: 'import'` was rejected outright by
 * gl_journal_entries_source_check (migration 509), so this whole path threw.
 *
 * Routing each group through createJournalEntry gets validateJournalEntry for
 * free; postJournalEntry then re-validates and checks the fiscal period.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn().mockResolvedValue({ status: 'posted' }),
}));

import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import {
  importJournalEntries,
  ImportValidationError,
} from '@/modules/accounting/services/gl/glImportExecuteService';
import type { ImportRow } from '@/modules/accounting/services/gl/glImportService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const createMock = createJournalEntry as unknown as MockedFunction<
  (...a: unknown[]) => Promise<{ id: string }>
>;
const postMock = postJournalEntry as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;

type Line = { glAccountId: string; debit: number; credit: number };
const sum = (ls: Line[], k: 'debit' | 'credit') => ls.reduce((t, l) => t + l[k], 0);

/** Chart of accounts + cost centres the service resolves codes against. */
function withAccounts(codes: Record<string, string>) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM gl_accounts')) {
      return Promise.resolve(Object.entries(codes).map(([account_code, id]) => ({ account_code, id })));
    }
    if (text.includes('FROM cost_centres')) {
      return Promise.resolve([{ code: 'CC1', id: 'cc-1' }]);
    }
    return Promise.resolve([]);
  }) as never);
}

const ACCOUNTS = { '1000': 'acct-bank', '4000': 'acct-sales' };

function row(over: Partial<ImportRow>): ImportRow {
  return {
    date: '2026-08-13',
    accountCode: '1000',
    description: 'test',
    reference: 'REF1',
    debit: 0,
    credit: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  createMock.mockImplementation(async () => ({ id: `je-${++n}` }));
  postMock.mockResolvedValue({ status: 'posted' });
});

describe('importJournalEntries', () => {
  const balancedPair: ImportRow[] = [
    row({ accountCode: '1000', debit: 1000, credit: 0 }),
    row({ accountCode: '4000', debit: 0, credit: 1000 }),
  ];

  it('creates one balanced entry per date+reference group', async () => {
    withAccounts(ACCOUNTS);

    const result = await importJournalEntries(COMPANY, balancedPair, USER, false);

    expect(createMock).toHaveBeenCalledTimes(1);
    const input = createMock.mock.calls[0]![1] as { lines: Line[]; source: string };
    expect(sum(input.lines, 'debit')).toBe(1000);
    expect(sum(input.lines, 'credit')).toBe(1000);
    expect(result).toMatchObject({ entriesCreated: 1, linesCreated: 2, totalValue: 1000 });
  });

  it('splits rows into separate entries per group', async () => {
    withAccounts(ACCOUNTS);

    await importJournalEntries(
      COMPANY,
      [
        ...balancedPair,
        row({ reference: 'REF2', accountCode: '1000', debit: 250, credit: 0 }),
        row({ reference: 'REF2', accountCode: '4000', debit: 0, credit: 250 }),
      ],
      USER,
      false,
    );

    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('THROWS on an unmapped account code instead of dropping the row', async () => {
    withAccounts(ACCOUNTS);

    const rows = [
      row({ accountCode: '1000', debit: 1000, credit: 0 }),
      row({ accountCode: '9999', debit: 0, credit: 1000 }), // not in the chart
    ];

    // Previously: the 9999 row was skipped and a 1000-debit entry with no
    // credit was posted.
    await expect(importJournalEntries(COMPANY, rows, USER, false)).rejects.toThrow(/9999/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('does not post any group when a later group has an unmapped code', async () => {
    withAccounts(ACCOUNTS);

    const rows = [
      ...balancedPair,
      row({ reference: 'REF2', accountCode: '9999', debit: 500, credit: 0 }),
      row({ reference: 'REF2', accountCode: '4000', debit: 0, credit: 500 }),
    ];

    // Validation runs across every row before the first entry is created, so a
    // bad row late in the file cannot leave earlier groups half-imported.
    await expect(importJournalEntries(COMPANY, rows, USER, false)).rejects.toThrow(/9999/);
    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  // The route (pages/api/accounting/gl-import.ts) answers 400 for an
  // ImportValidationError, and withAuth COMMITs a 4xx. So every reason to
  // reject a file must be found BEFORE the first entry is written — otherwise
  // the user is told the import failed while a prefix of it stays posted, and
  // re-uploading posts that prefix again (no idempotency key on this path).
  it('rejects an unbalanced group without writing ANY entry, including earlier valid groups', async () => {
    withAccounts(ACCOUNTS);

    const rows = [
      ...balancedPair,                                                          // REF1: valid
      row({ reference: 'REF2', accountCode: '1000', debit: 500, credit: 0 }),   // REF2: 500 debit
      row({ reference: 'REF2', accountCode: '4000', debit: 0, credit: 400 }),   // vs 400 credit
    ];

    await expect(importJournalEntries(COMPANY, rows, USER, false)).rejects.toThrow(/not balanced/i);

    // REF1 must NOT have been created — it is ordered before the bad group.
    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('names the offending group so the file can be corrected', async () => {
    withAccounts(ACCOUNTS);

    await expect(
      importJournalEntries(COMPANY, [
        row({ reference: 'REF9', accountCode: '1000', debit: 500, credit: 0 }),
        row({ reference: 'REF9', accountCode: '4000', debit: 0, credit: 400 }),
      ], USER, false),
    ).rejects.toThrow(/REF9/);
  });

  it('flags validation failures as ImportValidationError so the route may 400 them', async () => {
    withAccounts(ACCOUNTS);

    // The route keys off this type: anything else propagates to a 500 and rolls
    // back, because it can only have happened mid-write.
    await expect(
      importJournalEntries(COMPANY, [row({ accountCode: '9999', debit: 1, credit: 0 })], USER, false),
    ).rejects.toBeInstanceOf(ImportValidationError);
  });

  it('refuses financial posting without an authenticated control transaction', async () => {
    withAccounts(ACCOUNTS);

    await expect(importJournalEntries(COMPANY, balancedPair, USER, true)).rejects.toThrow('Authenticated control transaction');
    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('leaves entries as drafts when postImmediately is not set', async () => {
    withAccounts(ACCOUNTS);

    await importJournalEntries(COMPANY, balancedPair, USER, false);

    expect(postMock).not.toHaveBeenCalled();
  });

  it('uses the auto_gl_import source the CHECK constraint accepts', async () => {
    withAccounts(ACCOUNTS);

    await importJournalEntries(COMPANY, balancedPair, USER, false);

    const input = createMock.mock.calls[0]![1] as { source: string };
    expect(input.source).toBe('auto_gl_import');
  });

  it('resolves cost centres by code onto the line', async () => {
    withAccounts(ACCOUNTS);

    await importJournalEntries(
      COMPANY,
      [
        row({ accountCode: '1000', debit: 1000, credit: 0, costCentre: 'cc1' }),
        row({ accountCode: '4000', debit: 0, credit: 1000 }),
      ],
      USER,
      false,
    );

    const input = createMock.mock.calls[0]![1] as { lines: Array<Line & { costCenterId?: string }> };
    expect(input.lines[0]!.costCenterId).toBe('cc-1');
  });
});
