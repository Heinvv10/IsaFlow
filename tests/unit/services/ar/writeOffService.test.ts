/**
 * Unit tests for writeOffService.ts — approveWriteOff linkage handling.
 *
 * Same bug class as creditNoteService.approveCreditNote (H3) and the H6
 * sweep: gl_journal_entries.source_document_id has an FK to
 * captured_documents(id) only (migration 409, VALIDATED in prod).
 * approveWriteOff used to pass sourceDocumentId: id (a customer_write_offs
 * id, never a captured_documents id), which would violate that FK on any
 * environment where it's enforced. The write-off <-> journal entry link is
 * instead persisted via customer_write_offs.gl_journal_entry_id.
 *
 * (entryDate here already used fmtDate before this fix — write_off_date is
 * not part of this change.)
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
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

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { approveWriteOff } from '@/modules/accounting/services/ar/writeOffService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<typeof getSystemAccount>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const WO_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';
const INVOICE_ID = '55555555-5555-5555-5555-555555555555';

/**
 * `claimUnderLockTimeout` refuses to claim outside a request transaction — the
 * claim would autocommit and could not be rolled back with the posting that
 * follows it. These unit tests mock `sql`, so the client only has to exist;
 * `SET LOCAL` goes to the stub.
 */
const requestCtx = {
  client: { query: vi.fn() }, userId: USER_ID, companyId: COMPANY_ID, claims: {},
} as unknown as Parameters<typeof als.run>[0];
const inRequestTx = <T>(fn: () => Promise<T>): Promise<T> => als.run(requestCtx, fn);


function sqlCallTouches(call: unknown[], textFragment: string, value: unknown): boolean {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const text = Array.isArray(strings) ? strings.join('') : '';
  return text.includes(textFragment) && values.includes(value);
}

function writeOffRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WO_ID,
    write_off_number: 'WO-2026-00001',
    client_id: 'client-uuid',
    invoice_id: INVOICE_ID,
    invoice_number: 'INV-001',
    amount: 500,
    reason: 'Uncollectible',
    write_off_date: new Date(2026, 6, 4),
    status: 'draft',
    gl_journal_entry_id: null,
    approved_by: null,
    approved_at: null,
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
    source: 'auto_write_off',
    status: 'draft',
    createdBy: USER_ID,
    createdAt: '2026-07-04T00:00:00Z',
    updatedAt: '2026-07-04T00:00:00Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockPostJournalEntry.mockResolvedValue(undefined);
});

describe('approveWriteOff — no sourceDocumentId, linked via gl_journal_entry_id', () => {
  it('does not pass sourceDocumentId to createJournalEntry (would violate fk_gl_je_source_document)', async () => {
    mockSql
      .mockResolvedValueOnce([writeOffRow()]) // SELECT customer_write_offs JOIN customer_invoices
      .mockResolvedValueOnce([{ id: WO_ID }]) // the status-predicated CLAIM, one row = won
      .mockResolvedValueOnce([{ total_amount: 1000, tax_amount: 130.43 }]) // SELECT invoice VAT details
      .mockResolvedValueOnce([]) // UPDATE customer_invoices
      .mockResolvedValueOnce([writeOffRow({ status: 'approved', gl_journal_entry_id: JE_ID })]); // UPDATE ... RETURNING *

    await inRequestTx(() => approveWriteOff(COMPANY_ID, WO_ID, USER_ID));

    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1);
    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.sourceDocumentId).toBeUndefined();
  });

  it('persists gl_journal_entry_id on the write-off when approving', async () => {
    mockSql
      .mockResolvedValueOnce([writeOffRow()])
      .mockResolvedValueOnce([{ id: WO_ID }]) // CLAIM
      .mockResolvedValueOnce([{ total_amount: 1000, tax_amount: 130.43 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([writeOffRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    const result = await inRequestTx(() => approveWriteOff(COMPANY_ID, WO_ID, USER_ID));

    expect(result.glJournalEntryId).toBe(JE_ID);
    const updateCall = mockSql.mock.calls[4]!;
    expect(sqlCallTouches(updateCall, 'gl_journal_entry_id', JE_ID)).toBe(true);
  });
});
