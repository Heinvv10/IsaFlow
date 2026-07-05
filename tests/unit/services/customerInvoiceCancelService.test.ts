// RED phase — written before implementation (A–Z programme P1.1, audit C1)
/**
 * Unit tests for customerInvoiceCancelService.cancelCustomerInvoice.
 *
 * Audit C1 (2026-07-04): cancelling an approved invoice was a status flip
 * only — the approval journal stayed posted, permanently overstating
 * AR/Revenue/VAT (Britech INV0000134 R28,750; Demo JE-2026-00927 R1,725).
 *
 * The correct behavior pinned here:
 *   - posted invoice (has gl_journal_entry_id) → reverseJournalEntry runs
 *     BEFORE the status flip; reversal failure (e.g. locked period) aborts
 *     the cancel entirely.
 *   - invoice with payments/credits applied cannot be cancelled.
 *   - already-cancelled invoices cannot be re-cancelled.
 *   - draft invoices (no journal) cancel with a plain flip.
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
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  reverseJournalEntry: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockReverse = reverseJournalEntry as unknown as MockedFunction<
  (companyId: string, id: string, userId: string) => Promise<{ id: string }>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const JOURNAL_ID = 'dddddddd-0000-4000-8000-dddddddddddd';
const REVERSAL_ID = 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: 'approved',
    amount_paid: '0.00',
    gl_journal_entry_id: JOURNAL_ID,
    ...overrides,
  };
}

describe('cancelCustomerInvoice (P1.1 / audit C1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverses the approval journal BEFORE flipping status, and links the reversal', async () => {
    mockSql
      .mockResolvedValueOnce([invoiceRow()]) // SELECT invoice
      .mockResolvedValueOnce([{ id: INVOICE_ID }]); // UPDATE → cancelled
    mockReverse.mockResolvedValueOnce({ id: REVERSAL_ID });

    const result = await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).toHaveBeenCalledWith(COMPANY_ID, JOURNAL_ID, USER_ID);
    expect(result).toEqual({ status: 'cancelled', reversalJournalEntryId: REVERSAL_ID });

    // The status UPDATE ran after the reversal and is tenant-scoped.
    const updateCall = mockSql.mock.calls[1]!;
    const updateText = (updateCall[0] as string[]).join('?');
    expect(updateText).toMatch(/UPDATE customer_invoices/i);
    expect(updateText).toMatch(/status\s*=/i);
    expect(updateCall.slice(1)).toContain(COMPANY_ID);
    expect(mockReverse.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSql.mock.invocationCallOrder[1]!,
    );
  });

  it('propagates reversal failure (e.g. locked period) and never flips status', async () => {
    mockSql.mockResolvedValueOnce([invoiceRow()]);
    mockReverse.mockRejectedValueOnce(new Error('Fiscal period is closed'));

    await expect(cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /period/i,
    );
    // Only the SELECT ran — no UPDATE.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('blocks cancel when payments or credits are applied', async () => {
    mockSql.mockResolvedValueOnce([invoiceRow({ amount_paid: '115.00' })]);

    await expect(cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /payment/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('blocks re-cancelling an already-cancelled invoice', async () => {
    mockSql.mockResolvedValueOnce([invoiceRow({ status: 'cancelled', gl_journal_entry_id: null })]);

    await expect(cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /already cancelled/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('cancels a draft (no journal) with a plain flip — no reversal attempted', async () => {
    mockSql
      .mockResolvedValueOnce([invoiceRow({ status: 'draft', gl_journal_entry_id: null })])
      .mockResolvedValueOnce([{ id: INVOICE_ID }]);

    const result = await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'cancelled', reversalJournalEntryId: null });
  });

  it('returns null when the invoice does not exist for this tenant', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('tenant-scopes the invoice lookup', async () => {
    mockSql.mockResolvedValueOnce([]);
    await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    const selectCall = mockSql.mock.calls[0]!;
    const selectText = (selectCall[0] as string[]).join('?');
    expect(selectText).toMatch(/company_id/i);
    expect(selectCall.slice(1)).toContain(COMPANY_ID);
  });
});
