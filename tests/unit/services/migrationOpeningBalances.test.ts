/**
 * Migration opening balances must post a balanced journal or none at all.
 *
 * The opening-balance step resolved each account's GL id in a loop and did
 * `if (glRows.length === 0) continue;` — an account that failed to import in
 * step 1 was dropped from the journal while every other account kept its
 * balance. The entry then went in via a hand-rolled INSERT already at
 * status='posted', and trg_gl_je_balanced only fires on UPDATE, so the
 * resulting lopsided opening balance was never checked. The company started
 * life with a trial balance that did not sum to zero.
 *
 * executeMigration reports through `errors[]` rather than throwing (it returns
 * partial success by design), so the fix follows that contract: a dropped
 * account or an unbalanced source trial balance is recorded and the journal is
 * NOT posted. Nothing is plugged to a suspense account — inventing equity to
 * paper over a bad source file would hide the problem it is reporting.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn().mockResolvedValue([]),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    transaction: vi.fn().mockResolvedValue([]),
    withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(sqlMock)),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-ob-1' }),
  postJournalEntry: vi.fn().mockResolvedValue({ id: 'je-ob-1', status: 'posted' }),
}));

import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { executeMigration } from '@/modules/accounting/services/core/migrationExecuteService';
import type { ParsedAccount } from '@/modules/accounting/services/core/migrationParserService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const createMock = createJournalEntry as unknown as MockedFunction<
  (...a: unknown[]) => Promise<{ id: string }>
>;
const postMock = postJournalEntry as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;

type Line = { glAccountId: string; debit: number; credit: number };
const sum = (ls: Line[], k: 'debit' | 'credit') => ls.reduce((t, l) => t + l[k], 0);

function acct(over: Partial<ParsedAccount>): ParsedAccount {
  return {
    sourceCode: '1000',
    sourceName: 'Bank',
    sourceType: 'Bank',
    mappedType: 'asset',
    mappedSubtype: 'bank',
    mappedNormalBalance: 'debit',
    openingBalance: 0,
    ...over,
  } as ParsedAccount;
}

/**
 * Resolve gl_accounts lookups by account_code. Codes listed in `missing` come
 * back empty, standing in for an account whose import failed in step 1. Codes
 * listed in `notOwned` come back with a NULL `imported_from`: the account
 * exists but this source does not own it — the company's own account, or one a
 * partial rollback released back to it.
 */
function withResolvableAccounts(missing: string[] = [], notOwned: string[] = []) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM gl_accounts')) {
      const code = vals.find(v => typeof v === 'string' && /^\d+$/.test(v)) as string | undefined;
      if (code && missing.includes(code)) return Promise.resolve([]);
      const owner = code && notOwned.includes(code) ? null : 'xero';
      return Promise.resolve([{ id: `gl-${code ?? 'x'}`, imported_from: owner }]);
    }
    return Promise.resolve([]);
  }) as never);
}

/** A source trial balance that sums to zero: 5000 debit vs 5000 credit. */
const BALANCED: ParsedAccount[] = [
  acct({ sourceCode: '1000', sourceName: 'Bank', mappedNormalBalance: 'debit', openingBalance: 5000 }),
  acct({
    sourceCode: '3000', sourceName: 'Share capital', mappedType: 'equity',
    mappedNormalBalance: 'credit', openingBalance: 5000,
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'je-ob-1' });
  postMock.mockResolvedValue({ id: 'je-ob-1', status: 'posted' });
});

describe('executeMigration — opening balances', () => {
  it('posts a balanced opening-balance journal through the posting service', async () => {
    withResolvableAccounts();

    const result = await executeMigration(COMPANY, USER, 'xero', BALANCED, [], []);

    expect(createMock).toHaveBeenCalledTimes(1);
    const input = createMock.mock.calls[0]![1] as { lines: Line[]; source: string };
    expect(sum(input.lines, 'debit')).toBe(5000);
    expect(sum(input.lines, 'credit')).toBe(5000);
    expect(input.source).toBe('auto_migration');

    expect(postMock).toHaveBeenCalledWith(COMPANY, 'je-ob-1', USER);
    expect(result.openingBalancesSet).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('does NOT post when an account could not be resolved, and reports it', async () => {
    withResolvableAccounts(['3000']); // share capital failed to import

    const result = await executeMigration(COMPANY, USER, 'xero', BALANCED, [], []);

    // Previously: the 3000 credit was skipped and a lone 5000 debit posted.
    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(result.openingBalancesSet).toBe(0);
    expect(result.errors.join(' ')).toMatch(/3000/);
  });

  it('does NOT post onto an account this source does not own, and says which', async () => {
    withResolvableAccounts([], ['3000']); // released by a partial rollback

    const result = await executeMigration(COMPANY, USER, 'xero', BALANCED, [], []);

    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(result.openingBalancesSet).toBe(0);
    // Naming the real cause matters: "no GL account was created" sent the
    // operator looking for an import failure that never happened.
    expect(result.errors.join(' ')).toContain('3000 Share capital already exists as an account the xero import does not own');
  });

  it('reports a missing account and a not-owned one in the SAME refusal', async () => {
    withResolvableAccounts(['1000'], ['3000']);

    const result = await executeMigration(COMPANY, USER, 'xero', BALANCED, [], []);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.openingBalancesSet).toBe(0);
    // One message, both causes. Naming only the first sends the operator round
    // the loop again to meet the second for the first time.
    const message = result.errors.join(' ');
    expect(message).toContain('no GL account was created for 1000 Bank');
    expect(message).toContain('3000 Share capital already exists as an account the xero import does not own');
  });

  it('does NOT post when the source trial balance does not sum to zero', async () => {
    withResolvableAccounts();

    const lopsided: ParsedAccount[] = [
      acct({ sourceCode: '1000', mappedNormalBalance: 'debit', openingBalance: 5000 }),
      acct({
        sourceCode: '3000', sourceName: 'Share capital', mappedType: 'equity',
        mappedNormalBalance: 'credit', openingBalance: 4000,
      }),
    ];

    const result = await executeMigration(COMPANY, USER, 'xero', lopsided, [], []);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.openingBalancesSet).toBe(0);
    // The operator needs the number to go and fix the source file.
    expect(result.errors.join(' ')).toMatch(/1000\.00|1000/);
  });

  it('reports a posting failure without claiming balances were set', async () => {
    withResolvableAccounts();
    postMock.mockRejectedValue(new Error('Cannot post to closed fiscal period'));

    const result = await executeMigration(COMPANY, USER, 'xero', BALANCED, [], []);

    expect(result.openingBalancesSet).toBe(0);
    expect(result.errors.join(' ')).toMatch(/closed fiscal period/);
  });

  it('skips the opening-balance journal entirely when every balance is zero', async () => {
    withResolvableAccounts();

    const result = await executeMigration(
      COMPANY, USER, 'xero',
      [acct({ sourceCode: '1000', openingBalance: 0 })],
      [], [],
    );

    expect(createMock).not.toHaveBeenCalled();
    expect(result.openingBalancesSet).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
