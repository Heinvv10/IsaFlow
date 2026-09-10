/**
 * Unit tests for reverseJournalEntry — reversal semantics fix.
 *
 * Standard-accounting reversal: the ORIGINAL entry MUST stay status='posted'
 * and the posted contra offsets it, so both are counted by posted-only reports
 * and the gl_account_balances cache, netting the pair to zero. "Reversed" is
 * metadata (reversed_at / reversed_by / reversal_of_id) — NOT a status flip.
 * Flipping the original out of 'posted' was the bug that drove reversed accounts
 * to the negative of the original.
 *
 * The crud collaborators are mocked so this isolates reverseJournalEntry's own
 * logic (getJournalEntryById / createJournalEntry are exercised end-to-end in
 * dev; here we assert the metadata-not-status write and the reversed_at guard).
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
  };
});
vi.mock('@/lib/alsTransaction', async () => {
  const { als } = await import('@/lib/als');
  return {
    // reverseJournalEntry wraps itself in a transaction (withAlsTransaction) so
    // the reversal claim cannot outlive the contra, and the claim REFUSES to run
    // without one. Bind a client whose BEGIN/COMMIT and lock_timeout statements
    // are no-ops, so this suite keeps asserting reversal semantics.
    withAlsTransaction: (
      actor: { userId: string; companyId: string | undefined },
      fn: () => Promise<unknown>,
    ) =>
      als.run(
        {
          client: { query: async () => ({ rows: [{ v: '0' }] }) } as never,
          userId: actor.userId,
          companyId: actor.companyId,
          claims: {},
        },
        fn,
      ),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  getJournalEntryById: vi.fn(),
  createJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn(async (u: string) => u),
  mapEntryRow: vi.fn((r: unknown) => r),
}));
// actorMeta is REAL here: the two tests below assert what the contra is
// stamped with, and mocking the very function that assembles that stamp would
// make them pass whatever it does.
vi.mock('@/modules/accounting/services/gl/journalEntryMeta', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/gl/journalEntryMeta')>(
    '@/modules/accounting/services/gl/journalEntryMeta');
  return { ...actual, defaultHumanMeta: vi.fn(() => ({ postingAgent: 'human' })) };
});
// reverseJournalEntry asks whether the ORIGINAL entry's period is still open,
// to decide whether the contra can carry the original date. Mocked so this
// suite keeps asserting reversal SEMANTICS against a fixed `sql` call sequence;
// the date decision itself is pinned in journalEntryReversalDate.test.ts.
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: vi.fn(async () => 'closed' as const),
}));

import { sql } from '@/lib/neon';
import { getJournalEntryById, createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const mockGetById = getJournalEntryById as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;
const mockCreate = createJournalEntry as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const ENTRY_ID = '22222222-2222-2222-2222-222222222222';
const REVERSAL_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FISCAL_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function originalEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    entryNumber: 'JE-2026-00001',
    status: 'posted',
    reversedAt: undefined,
    source: 'auto_invoice',
    fiscalPeriodId: FISCAL_ID,
    lines: [
      { glAccountId: ACCOUNT_A, debit: 1000, credit: 0, description: 'AR' },
      { glAccountId: ACCOUNT_B, debit: 0, credit: 1000, description: 'Revenue' },
    ],
    ...overrides,
  };
}

/** The posted contra as getJournalEntryById returns it inside postJournalEntry. */
function contraEntryDraft() {
  return {
    id: REVERSAL_ID,
    entryNumber: 'JE-2026-00002',
    status: 'draft',
    fiscalPeriodId: FISCAL_ID,
    lines: [
      { glAccountId: ACCOUNT_A, debit: 0, credit: 1000 },
      { glAccountId: ACCOUNT_B, debit: 1000, credit: 0 },
    ],
  };
}

function joinSql(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ');
}

beforeEach(() => vi.clearAllMocks());

describe('reverseJournalEntry — semantics', () => {
  it.each(['capital_goods', 'standard', 'zero_rated', undefined])(
    'preserves VAT classification %s on the contra lines', async (vatType) => {
      const original = originalEntry();
      const lines = original.lines.map((line, i) => ({ ...line, vatType: i === 0 ? vatType : undefined }));
      mockGetById.mockResolvedValueOnce({ ...original, lines }).mockResolvedValueOnce(contraEntryDraft());
      mockCreate.mockResolvedValueOnce({ id: REVERSAL_ID });
      mockSql
        // reverseJournalEntry claims the reversal BEFORE creating the contra:
        // one row back means this caller won it (journalEntryReversalClaim).
        .mockResolvedValueOnce([{ id: ENTRY_ID }])
        .mockResolvedValueOnce([{ status: 'open' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: 'posted' }])
        // the contra link-back
        .mockResolvedValueOnce([]);

      await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID);

      const input = mockCreate.mock.calls[0]![1] as { lines: typeof lines };
      expect(input.lines.map(line => line.vatType)).toEqual([vatType, undefined]);
      expect(input.lines[0]!.credit).toBe(lines[0]!.debit);
      expect(input.lines[1]!.debit).toBe(lines[1]!.credit);
    },
  );

  it.each([
    ['66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777'],
    [undefined, undefined],
  ])('preserves each line business unit when reversing (%s, %s)', async (firstBu, secondBu) => {
    const original = originalEntry();
    const lines = original.lines.map((line, i) => ({ ...line, buId: i === 0 ? firstBu : secondBu }));
    mockGetById.mockResolvedValueOnce({ ...original, lines }).mockResolvedValueOnce(contraEntryDraft());
    mockCreate.mockResolvedValueOnce({ id: REVERSAL_ID });
    // The contra carries a dimension forward only when this company OWNS it
    // (reversalLines.ts), so the ownership SELECT runs BEFORE the claim and
    // answers that both business units are ours. It is skipped entirely when no
    // line carries one — hence the conditional, which mirrors ownedIds'
    // empty-list return.
    if (firstBu !== undefined) {
      mockSql.mockResolvedValueOnce([{ id: firstBu }, { id: secondBu }]);
    }
    mockSql
      // reverseJournalEntry claims the reversal BEFORE creating the contra: one
      // row back means this caller won it (see journalEntryReversalClaim).
      .mockResolvedValueOnce([{ id: ENTRY_ID }])
      .mockResolvedValueOnce([{ status: 'open' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: 'posted' }])
      // the contra link-back
      .mockResolvedValueOnce([]);

    await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID);

    const input = mockCreate.mock.calls[0]![1] as { lines: typeof lines };
    expect(input.lines.map(line => line.buId)).toEqual([firstBu, secondBu]);
    for (let i = 0; i < lines.length; i++) {
      expect(input.lines[i]!.debit).toBe(lines[i]!.credit);
      expect(input.lines[i]!.credit).toBe(lines[i]!.debit);
    }
  });

  it('drops a business unit this company does not own instead of refusing the reversal', async () => {
    const foreignBu = '88888888-8888-8888-8888-888888888888';
    const original = originalEntry();
    const lines = original.lines.map((line, i) => (i === 0 ? { ...line, buId: foreignBu } : line));
    mockGetById.mockResolvedValueOnce({ ...original, lines }).mockResolvedValueOnce(contraEntryDraft());
    mockCreate.mockResolvedValueOnce({ id: REVERSAL_ID });
    mockSql
      // The ownership SELECT finds nothing: the id belongs to another company.
      .mockResolvedValueOnce([])
      // then the reversal claim, and postJournalEntry's three reads.
      .mockResolvedValueOnce([{ id: ENTRY_ID }])
      .mockResolvedValueOnce([{ status: 'open' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: 'posted' }])
      // the contra link-back
      .mockResolvedValueOnce([]);

    // Refusing here would leave the entry permanently un-reversible — reversal
    // is the only correction this schema has.
    const result = await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID);

    const input = mockCreate.mock.calls[0]![1] as { lines: { buId?: string }[] };
    expect(input.lines[0]!.buId).toBeUndefined();
    expect((result as { foreignDimensionDroppedLines: number }).foreignDimensionDroppedLines).toBe(1);
  });

  it('marks the original with reversed_at metadata and does NOT flip its status', async () => {
    mockGetById
      .mockResolvedValueOnce(originalEntry()) // reverseJournalEntry: load original
      .mockResolvedValueOnce(contraEntryDraft()); // postJournalEntry: load the contra
    mockCreate.mockResolvedValueOnce({ id: REVERSAL_ID, entryNumber: 'JE-2026-00002' });
    // reverseJournalEntry's reversal claim; postJournalEntry's fiscal-period
    // check, inactive guard and UPDATE->posted; then the contra link-back.
    mockSql
      // reverseJournalEntry claims the reversal BEFORE creating the contra: one
      // row back means this caller won it (see journalEntryReversalClaim).
      .mockResolvedValueOnce([{ id: ENTRY_ID }])
      .mockResolvedValueOnce([{ status: 'open' }])
      // postJournalEntry's inactive-account guard: none on the contra
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ entry_number: 'JE-2026-00002', status: 'posted' }])
      // reverseJournalEntry's link-back UPDATE
      .mockResolvedValueOnce([]);

    const result = await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID);
    expect((result as { id: string }).id).toBe(REVERSAL_ID);

    const origUpdate = mockSql.mock.calls.find((c) => /reversed_by/.test(joinSql(c)));
    expect(origUpdate).toBeDefined();
    const text = joinSql(origUpdate!);
    expect(text).toMatch(/reversed_at\s*=\s*NOW\(\)/i);
    // The whole point of the fix: the original entry's status is never touched.
    expect(text).not.toMatch(/status\s*=/i);

    // And the contra is linked back via reversal_of_id.
    const linkUpdate = mockSql.mock.calls.find((c) => /reversal_of_id/.test(joinSql(c)));
    expect(linkUpdate).toBeDefined();
  });

  it('rejects a second reversal via the reversed_at guard (original stays posted)', async () => {
    mockGetById.mockResolvedValueOnce(originalEntry({ reversedAt: '2026-03-02T09:00:00Z' }));

    await expect(reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID)).rejects.toThrow('already reversed');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects reversing a non-posted (draft) entry', async () => {
    mockGetById.mockResolvedValueOnce(originalEntry({ status: 'draft' }));

    await expect(reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID)).rejects.toThrow('Can only reverse posted entries');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('reverseJournalEntry — contra attribution', () => {
  function primeHappyPath() {
    mockGetById
      .mockResolvedValueOnce(originalEntry())
      .mockResolvedValueOnce(contraEntryDraft());
    mockCreate.mockResolvedValueOnce({ id: REVERSAL_ID, entryNumber: 'JE-2026-00002' });
    mockSql
      // reverseJournalEntry claims the reversal BEFORE creating the contra: one
      // row back means this caller won it (see journalEntryReversalClaim).
      .mockResolvedValueOnce([{ id: ENTRY_ID }])
      .mockResolvedValueOnce([{ status: 'open' }])
      // postJournalEntry's inactive-account guard: none on the contra
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ entry_number: 'JE-2026-00002', status: 'posted' }])
      // reverseJournalEntry's link-back UPDATE
      .mockResolvedValueOnce([]);
  }

  it('stamps the contra with a caller-supplied posting agent instead of the human default', async () => {
    primeHappyPath();

    await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID, {
      postingAgent: 'mcp:reverse_bank_allocation:v1',
    });

    // The contra is a real posted journal. If it carries human:<userId> the
    // agent's own correction is invisible to list_agent_postings — the one
    // operation the attribution safety model cannot afford to lose.
    expect(mockCreate.mock.calls[0]![3]).toEqual({
      postingAgent: 'mcp:reverse_bank_allocation:v1',
    });
  });

  it('keeps the human default when no posting agent is supplied (existing callers)', async () => {
    primeHappyPath();

    await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID);

    expect(mockCreate.mock.calls[0]![3]).toEqual({ postingAgent: 'human' });
  });
});
