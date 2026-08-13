/**
 * Asset disposal and below-threshold expense must post a BALANCED journal
 * through the validated posting service — or fail loudly.
 *
 * Both hooks used to build the journal by hand: INSERT the header with
 * status='posted', then INSERT each leg behind its own `if`. Three defects
 * compounded:
 *
 *   1. `source` was 'asset_disposal' / 'asset_expense', neither of which
 *      gl_journal_entries_source_check permits, so the header INSERT always
 *      failed with 23514 (fixed by migration 509 + the auto_* rename).
 *   2. The catch logged and returned null, so dispose.ts answered 200 with
 *      journalEntryId: null — production has a disposed asset whose
 *      asset_disposals row still has journal_entry_id IS NULL.
 *   3. Even had the INSERT succeeded, the Cr Fixed Asset leg was conditional
 *      on assetAccountId, and trg_gl_je_balanced only fires on UPDATE — an
 *      INSERT that lands directly in status='posted' is never balance-checked.
 *      An asset with no category account would have posted debits with no
 *      matching credit.
 *
 * The fix is structural: build the lines, hand them to createJournalEntry
 * (which runs validateJournalEntry) and postJournalEntry. These tests assert
 * the legs balance, the correct source is used, and that a missing asset
 * account throws instead of posting a half-entry.
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
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-disposal-1' }),
  postJournalEntry: vi.fn().mockResolvedValue({ id: 'je-disposal-1', status: 'posted' }),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async (key: string) => `acct-${key}`),
}));

import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import {
  postAssetDisposalToGL,
  postCapitalizationExpenseToGL,
} from '@/modules/accounting/services/gl/glCrossModuleHooks';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const createMock = createJournalEntry as unknown as MockedFunction<
  (...a: unknown[]) => Promise<{ id: string }>
>;
const postMock = postJournalEntry as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;

/** The lines handed to createJournalEntry by the call under test. */
type Line = { glAccountId: string; debit: number; credit: number };
function linesFromCreate(): Line[] {
  const input = createMock.mock.calls[0]![1] as { lines: Line[] };
  return input.lines;
}
function inputFromCreate(): { source: string; reference?: string; entryDate: string } {
  return createMock.mock.calls[0]![1] as { source: string; reference?: string; entryDate: string };
}

const sum = (ls: Line[], k: 'debit' | 'credit') => ls.reduce((t, l) => t + l[k], 0);

/**
 * Stub the asset lookup, the explicit-account COALESCE, and the chart-of-
 * accounts fallback separately, so a test can have an asset with no explicit
 * account but a usable company fixed-asset account (the real production shape:
 * gl_asset_account_id is NULL on every asset and category, and nothing writes
 * it).
 */
function withAssetRow(assetAccountId: string | null, fallbackAccountId: string | null = null) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('COALESCE(a.gl_asset_account_id')) {
      return Promise.resolve([{ account_id: assetAccountId }]);
    }
    if (text.includes('FROM gl_accounts')) {
      return Promise.resolve(fallbackAccountId ? [{ id: fallbackAccountId }] : []);
    }
    if (text.includes('FROM assets')) {
      return Promise.resolve([{ id: 'asset-1', asset_number: 'FA-001', name: 'Bakkie' }]);
    }
    return Promise.resolve([]);
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'je-disposal-1' });
  postMock.mockResolvedValue({ id: 'je-disposal-1', status: 'posted' });
});

describe('postAssetDisposalToGL', () => {
  const base = {
    assetId: 'asset-1',
    policyAccDep: 40_000,
    cost: 100_000,
    proceeds: 50_000,
    gainLoss: -10_000, // carrying 60 000, sold for 50 000 => loss
    disposalDate: '2026-08-13',
  };

  it('posts a balanced journal through createJournalEntry + postJournalEntry', async () => {
    withAssetRow('acct-fixed-assets');

    const entryId = await postAssetDisposalToGL(COMPANY, base, USER);

    expect(entryId).toBe('je-disposal-1');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(COMPANY, 'je-disposal-1', USER);

    const lines = linesFromCreate();
    // Dr acc dep 40 000 + Dr bank 50 000 + Dr loss 10 000 = Cr cost 100 000
    expect(sum(lines, 'debit')).toBe(100_000);
    expect(sum(lines, 'credit')).toBe(100_000);
  });

  it('credits the fixed-asset account for full cost and debits the loss', async () => {
    withAssetRow('acct-fixed-assets');
    await postAssetDisposalToGL(COMPANY, base, USER);

    const lines = linesFromCreate();
    const assetLeg = lines.find(l => l.glAccountId === 'acct-fixed-assets');
    expect(assetLeg).toMatchObject({ debit: 0, credit: 100_000 });

    const plLeg = lines.find(l => l.glAccountId === 'acct-disposal_profit_loss');
    expect(plLeg).toMatchObject({ debit: 10_000, credit: 0 });
  });

  it('credits the P&L account when the disposal is a gain', async () => {
    withAssetRow('acct-fixed-assets');
    // carrying 60 000, sold for 75 000 => gain 15 000
    await postAssetDisposalToGL(COMPANY, { ...base, proceeds: 75_000, gainLoss: 15_000 }, USER);

    const lines = linesFromCreate();
    expect(lines.find(l => l.glAccountId === 'acct-disposal_profit_loss'))
      .toMatchObject({ debit: 0, credit: 15_000 });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('balances a scrapped asset (no proceeds, no accumulated depreciation)', async () => {
    withAssetRow('acct-fixed-assets');
    await postAssetDisposalToGL(
      COMPANY,
      { ...base, policyAccDep: 0, proceeds: 0, gainLoss: -100_000 },
      USER,
    );

    const lines = linesFromCreate();
    expect(sum(lines, 'debit')).toBe(100_000);
    expect(sum(lines, 'credit')).toBe(100_000);
    // No zero-value legs — validateJournalLine rejects debit === credit === 0.
    expect(lines.every(l => l.debit > 0 || l.credit > 0)).toBe(true);
  });

  it('THROWS when no asset account can be resolved at all, rather than posting an unbalanced entry', async () => {
    withAssetRow(null, null);

    await expect(postAssetDisposalToGL(COMPANY, base, USER)).rejects.toThrow(/fixed-asset account/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  // Production reality: gl_asset_account_id is NULL on all 6 assets and all 35
  // categories, and no code path writes either column. Requiring it outright
  // turned every disposal into a 400 with an instruction users cannot follow,
  // so the resolver falls back to a company fixed-asset account.
  it('falls back to the company fixed-asset account when the asset and category have none', async () => {
    withAssetRow(null, 'acct-coa-fixed-assets');

    const entryId = await postAssetDisposalToGL(COMPANY, base, USER);

    expect(entryId).toBe('je-disposal-1');
    const lines = linesFromCreate();
    expect(lines.find(l => l.glAccountId === 'acct-coa-fixed-assets'))
      .toMatchObject({ debit: 0, credit: 100_000 });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('prefers the asset/category account over the fallback when one is set', async () => {
    withAssetRow('acct-explicit', 'acct-coa-fixed-assets');

    await postAssetDisposalToGL(COMPANY, base, USER);

    const lines = linesFromCreate();
    expect(lines.find(l => l.glAccountId === 'acct-explicit')).toBeDefined();
    expect(lines.find(l => l.glAccountId === 'acct-coa-fixed-assets')).toBeUndefined();
  });

  it('uses the auto_asset_disposal source the CHECK constraint accepts', async () => {
    withAssetRow('acct-fixed-assets');
    await postAssetDisposalToGL(COMPANY, base, USER);

    expect(inputFromCreate().source).toBe('auto_asset_disposal');
  });

  it('puts the DIS- tag in reference, not entry_number', async () => {
    withAssetRow('acct-fixed-assets');
    await postAssetDisposalToGL(COMPANY, base, USER);

    // entry_number is UNIQUE per company and generated by trigger; two disposals
    // of one asset in a month would have collided on the old DIS-<asset>-<month>.
    expect(inputFromCreate().reference).toContain('FA-001');
    expect(inputFromCreate().entryDate).toBe('2026-08-13');
  });

  it('propagates a posting failure instead of returning null', async () => {
    withAssetRow('acct-fixed-assets');
    postMock.mockRejectedValue(new Error('Cannot post to closed fiscal period'));

    await expect(postAssetDisposalToGL(COMPANY, base, USER)).rejects.toThrow(/closed fiscal period/);
  });

  it('still returns null when the asset does not exist', async () => {
    sqlMock.mockResolvedValue([]);

    await expect(postAssetDisposalToGL(COMPANY, base, USER)).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('postCapitalizationExpenseToGL', () => {
  it('posts a balanced Dr expense / Cr bank pair via the posting service', async () => {
    withAssetRow(null); // asset account is irrelevant for the expense route

    const entryId = await postCapitalizationExpenseToGL(COMPANY, 'asset-1', 3_500, USER);

    expect(entryId).toBe('je-disposal-1');
    const lines = linesFromCreate();
    expect(sum(lines, 'debit')).toBe(3_500);
    expect(sum(lines, 'credit')).toBe(3_500);
    expect(inputFromCreate().source).toBe('auto_asset_expense');
    expect(postMock).toHaveBeenCalledWith(COMPANY, 'je-disposal-1', USER);
  });

  it('propagates failures rather than silently reporting success', async () => {
    withAssetRow(null);
    createMock.mockRejectedValue(new Error('boom'));

    await expect(postCapitalizationExpenseToGL(COMPANY, 'asset-1', 3_500, USER)).rejects.toThrow('boom');
  });

  it('returns null for a non-positive cost without posting', async () => {
    withAssetRow(null);

    await expect(postCapitalizationExpenseToGL(COMPANY, 'asset-1', 0, USER)).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});
