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
  return { sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  getJournalEntryById: vi.fn(),
  createJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn(async (u: string) => u),
  mapEntryRow: vi.fn((r: unknown) => r),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryMeta', () => ({
  defaultHumanMeta: vi.fn(() => ({ postingAgent: 'human' })),
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
  it('marks the original with reversed_at metadata and does NOT flip its status', async () => {
    mockGetById
      .mockResolvedValueOnce(originalEntry()) // reverseJournalEntry: load original
      .mockResolvedValueOnce(contraEntryDraft()); // postJournalEntry: load the contra
    mockCreate.mockResolvedValueOnce({ id: REVERSAL_ID, entryNumber: 'JE-2026-00002' });
    // postJournalEntry sql: fiscal-period check, then UPDATE->posted;
    // then reverseJournalEntry's two link-back UPDATEs.
    mockSql
      .mockResolvedValueOnce([{ status: 'open' }])
      .mockResolvedValueOnce([{ entry_number: 'JE-2026-00002', status: 'posted' }])
      .mockResolvedValueOnce([])
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
