// RED phase — written before implementation (A–Z programme P1.1 sweep, audit C1)
/**
 * cancelSupplierInvoice must reverse the GL journal posted at approval.
 *
 * Audit C1 called the cancel≠reversal gap SYSTEMIC: the customer-invoice path
 * was the headline, but supplier invoices post GL on approve
 * (postSupplierInvoiceToGL) and cancel was a bare status flip too.
 *
 * The service reads the invoice with SELECT … FOR UPDATE (concurrent cancels
 * must serialise — both passing the guards would double-reverse the journal)
 * and guards the flip with AND status != 'cancelled'.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    // Pass-through savepoint: the services wrap their bodies in withSavepoint
    // so a 400-path failure can't orphan-commit partial writes (PR #198 R2).
    withSavepoint: vi.fn((_name: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
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

vi.mock('@/modules/accounting/utils/threeWayMatch', () => ({
  validateThreeWayMatch: vi.fn(),
}));

vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  getSupplierInvoiceById: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { sql, withSavepoint } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import {
  cancelSupplierInvoice,
  postSupplierInvoiceToGL,
} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockReverse = reverseJournalEntry as unknown as MockedFunction<
  (companyId: string, id: string, userId: string) => Promise<{ id: string }>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const JOURNAL_ID = 'dddddddd-0000-4000-8000-dddddddddddd';
const REVERSAL_ID = 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

/** Row shape of the FOR UPDATE lock SELECT (snake_case, raw). */
function lockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: 'approved',
    gl_journal_entry_id: JOURNAL_ID,
    ...overrides,
  };
}

/** Minimal raw row for the UPDATE … RETURNING * that mapInvoiceRow can map. */
const updatedRow = { id: INVOICE_ID, status: 'cancelled', supplier_id: 'x', invoice_number: 'SIV-1' };

describe('cancelSupplierInvoice GL reversal (P1.1 sweep / audit C1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks the row FOR UPDATE and reverses the approval journal before flipping', async () => {
    mockSql
      .mockResolvedValueOnce([lockRow()]) // invoice lock
      .mockResolvedValueOnce([{ status: 'posted', reversed_at: null }]) // journal lock
      .mockResolvedValueOnce([updatedRow]); // UPDATE
    mockReverse.mockResolvedValueOnce({ id: REVERSAL_ID });

    await cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    const lockText = (mockSql.mock.calls[0]![0] as string[]).join('?');
    expect(lockText).toMatch(/FOR UPDATE/i);
    expect(lockText).toMatch(/company_id/i);
    expect(mockReverse).toHaveBeenCalledWith(COMPANY_ID, JOURNAL_ID, USER_ID);
    // reversal happens after the journal-state check, before the UPDATE
    expect(mockReverse.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockSql.mock.invocationCallOrder[1]!,
    );
    expect(mockReverse.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSql.mock.invocationCallOrder[2]!,
    );
    const updateText = (mockSql.mock.calls[2]![0] as string[]).join('?');
    expect(updateText).toMatch(/status != 'cancelled'/i);
    expect(updateText, 'cancel must clear the journal link').toMatch(
      /gl_journal_entry_id = NULL/i,
    );
  });

  it('skips the reversal when the journal is already reversed (reversed_at set)', async () => {
    mockSql
      .mockResolvedValueOnce([lockRow()])
      .mockResolvedValueOnce([{ status: 'posted', reversed_at: '2026-07-01T00:00:00Z' }])
      .mockResolvedValueOnce([updatedRow]);

    await cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('propagates reversal failure and never flips status', async () => {
    mockSql
      .mockResolvedValueOnce([lockRow()])
      .mockResolvedValueOnce([{ status: 'posted', reversed_at: null }]);
    mockReverse.mockRejectedValueOnce(new Error('Fiscal period is closed'));

    await expect(cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /period/i,
    );
    expect(mockSql).toHaveBeenCalledTimes(2); // locks only, no UPDATE
  });

  it('still blocks cancelling invoices with payments', async () => {
    mockSql.mockResolvedValueOnce([lockRow({ status: 'paid' })]);

    await expect(cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /payment/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('blocks re-cancelling an already-cancelled invoice', async () => {
    mockSql.mockResolvedValueOnce([lockRow({ status: 'cancelled', gl_journal_entry_id: null })]);

    await expect(cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /already cancelled/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('cancels an unposted invoice (no journal) without attempting a reversal', async () => {
    mockSql
      .mockResolvedValueOnce([lockRow({ status: 'pending', gl_journal_entry_id: null })])
      .mockResolvedValueOnce([updatedRow]);

    await cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('throws when a concurrent cancel wins the flip race', async () => {
    mockSql
      .mockResolvedValueOnce([lockRow({ status: 'pending', gl_journal_entry_id: null })])
      .mockResolvedValueOnce([]); // UPDATE matched 0 rows

    await expect(cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /concurrent/i,
    );
  });

  it('runs inside a savepoint so 400-path failures cannot orphan-commit partial writes', async () => {
    mockSql.mockResolvedValueOnce([lockRow({ status: 'cancelled', gl_journal_entry_id: null })]);
    await cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID).catch(() => undefined);

    expect(withSavepoint).toHaveBeenCalledWith('cancel_supplier_invoice', expect.any(Function));
  });

  it('postSupplierInvoiceToGL refuses cancelled invoices (link is NULL after cancel)', async () => {
    (getSupplierInvoiceById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: INVOICE_ID,
      status: 'cancelled',
      glJournalEntryId: undefined,
    });

    await expect(postSupplierInvoiceToGL(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /cancelled/i,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });
});
