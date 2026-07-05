/**
 * Unit tests for batchPaymentService.ts — processBatch linkage handling.
 *
 * Same bug class as creditNoteService.approveCreditNote (H3) and the H6
 * sweep: gl_journal_entries.source_document_id has an FK to
 * captured_documents(id) only (migration 409, VALIDATED in prod).
 * processBatch used to pass sourceDocumentId: id (a
 * supplier_payment_batches id, never a captured_documents id), which would
 * violate that FK on any environment where it's enforced. The batch <->
 * journal entry link is instead persisted via
 * supplier_payment_batches.gl_journal_entry_id.
 *
 * (entryDate here already used fmtDate before this fix — batch_date is not
 * part of this change.)
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock, withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)) };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { processBatch } from '@/modules/accounting/services/ap/batchPaymentService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<typeof getSystemAccount>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const BATCH_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';

function sqlCallTouches(call: unknown[], textFragment: string, value: unknown): boolean {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const text = Array.isArray(strings) ? strings.join('') : '';
  return text.includes(textFragment) && values.includes(value);
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    batch_number: 'BATCH-2026-00001',
    batch_date: new Date(2026, 6, 4),
    total_amount: 1000,
    payment_count: 0,
    payment_method: 'eft',
    bank_account_id: null,
    status: 'approved',
    gl_journal_entry_id: null,
    notes: null,
    processed_by: null,
    processed_at: null,
    created_by: USER_ID,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemAccount.mockImplementation(async (key: string) => ({
    id: `${key}-account-id`,
    accountCode: '1000',
    accountName: key,
    accountType: 'asset',
    accountSubtype: 'current',
  }));
  mockCreateJournalEntry.mockResolvedValue({
    id: JE_ID,
    entryNumber: 'JE-2026-00001',
    entryDate: '2026-07-04',
    source: 'auto_batch_payment',
    status: 'draft',
    createdBy: USER_ID,
    createdAt: '2026-07-04T00:00:00Z',
    updatedAt: '2026-07-04T00:00:00Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockPostJournalEntry.mockResolvedValue(undefined);
});

describe('processBatch — no sourceDocumentId, linked via gl_journal_entry_id', () => {
  it('does not pass sourceDocumentId to createJournalEntry (would violate fk_gl_je_source_document)', async () => {
    mockSql
      .mockResolvedValueOnce([batchRow()]) // getBatchById
      .mockResolvedValueOnce([]) // SELECT supplier_payments/payment_allocations (no payments in batch)
      .mockResolvedValueOnce([]) // UPDATE supplier_payments SET status='processed'
      .mockResolvedValueOnce([]); // UPDATE supplier_payment_batches SET status='processed', ... gl_journal_entry_id

    await processBatch(COMPANY_ID, BATCH_ID, USER_ID);

    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1);
    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.sourceDocumentId).toBeUndefined();
  });

  it('persists gl_journal_entry_id on the batch when processing', async () => {
    mockSql
      .mockResolvedValueOnce([batchRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await processBatch(COMPANY_ID, BATCH_ID, USER_ID);

    const finalUpdateCall = mockSql.mock.calls[3]!;
    expect(sqlCallTouches(finalUpdateCall, 'gl_journal_entry_id', JE_ID)).toBe(true);
  });
});
