/**
 * Unit tests for migrationImportService.ts — importARInvoices linkage handling.
 *
 * Same bug class as creditNoteService.approveCreditNote (H3) and the H6
 * sweep: gl_journal_entries.source_document_id has an FK to
 * captured_documents(id) only (migration 409, VALIDATED in prod).
 * importARInvoices used to pass sourceDocumentId: invoiceId (the newly
 * inserted customer_invoices id, never a captured_documents id), which
 * would violate that FK on any environment where it's enforced. Unlike the
 * H3-pattern services, customer_invoices.gl_journal_entry_id was NOT being
 * populated at all before this fix — added the missing UPDATE, matching
 * how postCustomerInvoiceToGL (customerPaymentAllocationService.ts) and
 * sageMigrationCommitService.ts use that same column for a supplier
 * invoice's own posting entry. Safe here because a migrated invoice is
 * inserted pre-approved and never goes through that flow afterward.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// R-035 PR4: the import exemption (a set_config pair in a savepoint) is
// covered in r035-pr4-imports.int.test.ts; here it only wraps the write.
vi.mock('@/modules/accounting/services/gl/approvalGateExempt', () => ({
  assertMayImportOpenBills: async () => undefined,
  withApprovalGateExempt: <T,>(_importer: unknown, write: () => Promise<T>) => write(),
}));
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
  getSystemAccountId: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/migrationService', () => ({
  updateSession: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importARInvoices, type ARInvoiceRow } from '@/modules/accounting/services/core/migrationImportService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
const mockGetSystemAccountId = getSystemAccountId as unknown as MockedFunction<typeof getSystemAccountId>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';
const INVOICE_ID = '55555555-5555-5555-5555-555555555555';
const CUSTOMER_ID = '66666666-6666-6666-6666-666666666666';

function sqlCallTouches(call: unknown[], textFragment: string, value: unknown): boolean {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const text = Array.isArray(strings) ? strings.join('') : '';
  return text.includes(textFragment) && values.includes(value);
}

const invoiceRow: ARInvoiceRow = {
  invoiceNumber: 'INV-MIG-001',
  customerName: 'Acme Corp',
  invoiceDate: '2026-07-04',
  dueDate: '2026-08-04',
  subtotal: 1000,
  taxAmount: 150,
  totalAmount: 1150,
  amountPaid: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemAccountId.mockResolvedValue('account-id');
  mockCreateJournalEntry.mockResolvedValue({
    id: JE_ID,
    entryNumber: 'JE-2026-00001',
    entryDate: '2026-07-04',
    source: 'auto_migration',
    status: 'draft',
    createdBy: USER_ID,
    createdAt: '2026-07-04T00:00:00Z',
    updatedAt: '2026-07-04T00:00:00Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockPostJournalEntry.mockResolvedValue(undefined);
});

describe('importARInvoices — no sourceDocumentId, linked via gl_journal_entry_id', () => {
  it('does not pass sourceDocumentId to createJournalEntry (would violate fk_gl_je_source_document)', async () => {
    mockSql
      .mockResolvedValueOnce([]) // pg_advisory_xact_lock
      .mockResolvedValueOnce([]) // steps_completed: no opening control total on the session
      .mockResolvedValueOnce([{ id: CUSTOMER_ID, name: 'Acme Corp' }]) // customers lookup
      .mockResolvedValueOnce([{ source_system: 'sage' }]) // migration_sessions source_system
      .mockResolvedValueOnce([{ id: INVOICE_ID }]) // INSERT customer_invoices RETURNING id
      .mockResolvedValueOnce([]); // UPDATE customer_invoices SET gl_journal_entry_id

    const result = await importARInvoices(COMPANY_ID, SESSION_ID, [invoiceRow], USER_ID);

    expect(result.imported).toBe(1);
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1);
    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.sourceDocumentId).toBeUndefined();
  });

  it('persists gl_journal_entry_id on the migrated invoice', async () => {
    mockSql
      .mockResolvedValueOnce([]) // pg_advisory_xact_lock
      .mockResolvedValueOnce([]) // steps_completed: no opening control total on the session
      .mockResolvedValueOnce([{ id: CUSTOMER_ID, name: 'Acme Corp' }])
      .mockResolvedValueOnce([{ source_system: 'sage' }])
      .mockResolvedValueOnce([{ id: INVOICE_ID }])
      .mockResolvedValueOnce([]);

    await importARInvoices(COMPANY_ID, SESSION_ID, [invoiceRow], USER_ID);

    const linkageCall = mockSql.mock.calls[5]!;
    expect(sqlCallTouches(linkageCall, 'gl_journal_entry_id', JE_ID)).toBe(true);
    expect(sqlCallTouches(linkageCall, 'gl_journal_entry_id', INVOICE_ID)).toBe(true);
  });
});

describe('importARInvoices — R-119: a take-on row may not carry a negative or NaN total', () => {
  it.each([
    ['a negative total', -1150],
    ['a NaN total', Number.NaN],
  ])('refuses %s by file row, names credit notes, and never reaches the INSERT', async (_label, totalAmount) => {
    mockSql
      .mockResolvedValueOnce([]) // pg_advisory_xact_lock
      .mockResolvedValueOnce([]) // steps_completed
      .mockResolvedValueOnce([{ id: CUSTOMER_ID, name: 'Acme Corp' }])
      .mockResolvedValueOnce([{ source_system: 'sage' }]);

    const result = await importARInvoices(
      COMPANY_ID, SESSION_ID, [{ ...invoiceRow, totalAmount }], USER_ID,
    );

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    const message = result.errors.map((e) => e.message).join(' ');
    expect(message).toMatch(/credit note/i);
    // fileRow falls back to the array index without an ImportRowContext, so
    // row 0 here is the first row of the batch — the point is that the error
    // carries the row at all, not that it is 1-based.
    expect(result.errors[0]!.row).toBe(0);
    // Refused BEFORE the row is written: nothing inserted, no journal posted,
    // so the operator is not told a raw trigger message from migration 692.
    expect(mockCreateJournalEntry).not.toHaveBeenCalled();
    const insertCalls = mockSql.mock.calls.filter((c) =>
      String((c as [readonly string[]])[0]?.join?.('') ?? '').includes('INSERT INTO customer_invoices'));
    expect(insertCalls).toHaveLength(0);
  });
});

describe('importARInvoices — R-119: a swapped LEG passes the drift check and must still be refused', () => {
  it('refuses subtotal 1200 / tax -200 / total 1000, which |subtotal+tax-total| accepts', async () => {
    mockSql
      .mockResolvedValueOnce([]) // pg_advisory_xact_lock
      .mockResolvedValueOnce([]) // steps_completed
      .mockResolvedValueOnce([{ id: CUSTOMER_ID, name: 'Acme Corp', vat_number: '4123456789' }])
      .mockResolvedValueOnce([{ source_system: 'sage' }]);

    const result = await importARInvoices(
      COMPANY_ID, SESSION_ID, [{ ...invoiceRow, subtotal: 1200, taxAmount: -200, totalAmount: 1000 }], USER_ID,
    );

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/credit note/i);
    expect(mockCreateJournalEntry).not.toHaveBeenCalled();
  });
});
