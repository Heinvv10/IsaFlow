/**
 * Unit tests for adjustmentService.ts — approveAdjustment date + linkage handling.
 *
 * Same bug class as creditNoteService.approveCreditNote (see
 * tests/unit/services/ar/creditNoteService.test.ts):
 *  1. adjustment_date comes back from pg as a Date object. String(Date)
 *     produced a locale string Postgres rejected on insert into
 *     gl_journal_entries.entry_date. Fixed via fmtDate (src/lib/neon.ts),
 *     not toISODate (src/lib/dateUtils.ts) — the latter formats via
 *     toISOString().slice(0, 10), which silently rolls the date back a day
 *     on this server's UTC+2 timezone because node-postgres constructs
 *     DATE columns at LOCAL midnight. The Date fixture below is built with
 *     `new Date(2026, 6, 4)` (local-time constructor) to actually exercise
 *     that distinction — a UTC-anchored fixture would not catch it.
 *  2. gl_journal_entries.source_document_id has an FK to captured_documents
 *     (id) only (migration 409, VALIDATED in prod). approveAdjustment must
 *     not pass sourceDocumentId: id (an accounting_adjustments id) to
 *     createJournalEntry — the adjustment <-> journal link is instead
 *     persisted via accounting_adjustments.gl_journal_entry_id.
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

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { approveAdjustment } from '@/modules/accounting/services/items/adjustmentService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<typeof getSystemAccount>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const ADJ_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';

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

function adjustmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ADJ_ID,
    adjustment_number: 'ADJ-2026-00001',
    entity_type: 'customer',
    entity_id: 'entity-uuid',
    adjustment_type: 'debit',
    amount: 500,
    reason: 'Balance correction',
    adjustment_date: new Date(2026, 6, 4), // local midnight — mirrors pg's DATE parsing
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
    source: 'auto_adjustment',
    status: 'draft',
    createdBy: USER_ID,
    createdAt: '2026-07-04T00:00:00Z',
    updatedAt: '2026-07-04T00:00:00Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockPostJournalEntry.mockResolvedValue(undefined);
});

describe('approveAdjustment — adjustment_date normalization', () => {
  it('formats a Date-typed adjustment_date as YYYY-MM-DD before creating the journal entry', async () => {
    mockSql
      .mockResolvedValueOnce([adjustmentRow()]) // SELECT accounting_adjustments
      .mockResolvedValueOnce([{ id: ADJ_ID }]) // the status-predicated CLAIM, one row = won
      .mockResolvedValueOnce([adjustmentRow({ status: 'approved', gl_journal_entry_id: JE_ID })]); // UPDATE ... RETURNING *

    await inRequestTx(() => approveAdjustment(COMPANY_ID, ADJ_ID, USER_ID));

    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1);
    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });

  it('formats a string-typed (ISO timestamp) adjustment_date as YYYY-MM-DD', async () => {
    mockSql
      .mockResolvedValueOnce([adjustmentRow({ adjustment_date: '2026-07-04T00:00:00.000Z' })])
      .mockResolvedValueOnce([{ id: ADJ_ID }]) // CLAIM
      .mockResolvedValueOnce([adjustmentRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    await inRequestTx(() => approveAdjustment(COMPANY_ID, ADJ_ID, USER_ID));

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });
});

describe('approveAdjustment — no sourceDocumentId, linked via gl_journal_entry_id', () => {
  it('does not pass sourceDocumentId to createJournalEntry (would violate fk_gl_je_source_document)', async () => {
    mockSql
      .mockResolvedValueOnce([adjustmentRow()])
      .mockResolvedValueOnce([{ id: ADJ_ID }]) // CLAIM
      .mockResolvedValueOnce([adjustmentRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    await inRequestTx(() => approveAdjustment(COMPANY_ID, ADJ_ID, USER_ID));

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.sourceDocumentId).toBeUndefined();
  });

  it('persists gl_journal_entry_id on the adjustment when approving', async () => {
    mockSql
      .mockResolvedValueOnce([adjustmentRow()])
      .mockResolvedValueOnce([{ id: ADJ_ID }]) // CLAIM
      .mockResolvedValueOnce([adjustmentRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    const result = await inRequestTx(() => approveAdjustment(COMPANY_ID, ADJ_ID, USER_ID));

    expect(result.glJournalEntryId).toBe(JE_ID);
    const updateCall = mockSql.mock.calls[2]!;
    expect(sqlCallTouches(updateCall, 'gl_journal_entry_id', JE_ID)).toBe(true);
  });
});
