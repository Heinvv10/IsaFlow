// RED phase — written before the fix landed.
/**
 * Unit tests for creditNoteService.ts — approveCreditNote date handling.
 *
 * Bug: credit_date comes back from pg as a JS Date object. String(Date)
 * yields e.g. "Fri Jul 04 2026 00:00:00 GMT+0200 (South Africa Standard
 * Time)", which Postgres rejects with `time zone "gmt+0200" not
 * recognized` when inserted into gl_journal_entries.entry_date. That made
 * every credit note approval fail, which in turn blocked apply/cancel/
 * delete (all of which require an approved credit note first).
 *
 * These tests pin entryDate passed to createJournalEntry to 'YYYY-MM-DD'
 * for both Date-typed and string-typed credit_date values.
 *
 * Also covers a follow-up finding from the same investigation:
 * gl_journal_entries.source_document_id has an FK to captured_documents(id)
 * only (migration 409). approveCreditNote used to pass sourceDocumentId: id
 * (the credit note's own id), which would violate that FK on any
 * environment where it's enforced (confirmed VALIDATED in prod) — trading
 * the date crash for a new FK-violation crash. The credit_note <-> journal
 * entry link is instead persisted via credit_notes.gl_journal_entry_id.
 *
 * The Date fixture below is built with `new Date(2026, 6, 4)` (local-time
 * constructor), not `new Date('2026-07-04T00:00:00.000Z')` — node-postgres
 * itself constructs `DATE` column values at LOCAL midnight, so a fixture
 * anchored to UTC midnight would not catch a fix that uses UTC-based
 * slicing (e.g. `toISOString().slice(0, 10)`), which silently rolls the
 * date back a day on any server east of UTC (this one runs UTC+2). Real
 * `fmtDate` is imported via importActual so the test can't drift from the
 * true source of truth by re-implementing it.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
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
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<typeof getSystemAccount>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const CN_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';

// Tagged-template sql mock calls are (stringsArray, ...interpolatedValues).
// This checks a call's template text + interpolated values without caring
// about exact argument position, so it's robust to unrelated query edits.
function sqlCallTouches(call: unknown[], textFragment: string, value: unknown): boolean {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const text = Array.isArray(strings) ? strings.join('') : '';
  return text.includes(textFragment) && values.includes(value);
}

function creditNoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CN_ID,
    credit_note_number: 'CN-2026-00001',
    type: 'customer',
    client_id: 'client-uuid',
    customer_invoice_id: null,
    supplier_id: null,
    supplier_invoice_id: null,
    credit_date: new Date(2026, 6, 4), // local midnight — mirrors pg's DATE parsing
    reason: 'Damaged goods',
    subtotal: 1000,
    tax_rate: 15,
    tax_amount: 150,
    total_amount: 1150,
    status: 'draft',
    gl_journal_entry_id: null,
    project_id: null,
    created_by: USER_ID,
    approved_by: null,
    approved_at: null,
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
    source: 'auto_credit_note',
    status: 'draft',
    createdBy: USER_ID,
    createdAt: '2026-07-04T00:00:00Z',
    updatedAt: '2026-07-04T00:00:00Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockPostJournalEntry.mockResolvedValue(undefined);
});

describe('approveCreditNote — credit_date normalization', () => {
  it('formats a Date-typed credit_date as YYYY-MM-DD before creating the journal entry', async () => {
    mockSql
      .mockResolvedValueOnce([creditNoteRow()]) // SELECT credit_notes
      .mockResolvedValueOnce([creditNoteRow({ status: 'approved' })]); // UPDATE ... RETURNING *

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1);
    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });

  it('formats a string-typed (ISO timestamp) credit_date as YYYY-MM-DD', async () => {
    mockSql
      .mockResolvedValueOnce([creditNoteRow({ credit_date: '2026-07-04T00:00:00.000Z' })])
      .mockResolvedValueOnce([creditNoteRow({ status: 'approved' })]);

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });

  it('passes through a plain YYYY-MM-DD string credit_date unchanged', async () => {
    mockSql
      .mockResolvedValueOnce([creditNoteRow({ credit_date: '2026-07-04' })])
      .mockResolvedValueOnce([creditNoteRow({ status: 'approved' })]);

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });
});

describe('approveCreditNote — no sourceDocumentId, linked via gl_journal_entry_id', () => {
  it('does not pass sourceDocumentId to createJournalEntry (would violate fk_gl_je_source_document)', async () => {
    mockSql
      .mockResolvedValueOnce([creditNoteRow()])
      .mockResolvedValueOnce([creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.sourceDocumentId).toBeUndefined();
  });

  it('persists gl_journal_entry_id on the credit note when approving', async () => {
    mockSql
      .mockResolvedValueOnce([creditNoteRow()])
      .mockResolvedValueOnce([creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    const result = await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    expect(result.glJournalEntryId).toBe(JE_ID);
    const updateCall = mockSql.mock.calls[1]!;
    expect(sqlCallTouches(updateCall, 'gl_journal_entry_id', JE_ID)).toBe(true);
  });
});
