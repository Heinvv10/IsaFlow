// RED phase — written before implementation (A–Z programme P1.1 sweep, audit C1)
/**
 * cancelSupplierInvoice must reverse the GL journal posted at approval.
 *
 * Audit C1 called the cancel≠reversal gap SYSTEMIC: the customer-invoice path
 * was the headline, but supplier invoices post GL on approve
 * (postSupplierInvoiceToGL) and cancel was a bare status flip too.
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

import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockReverse = reverseJournalEntry as unknown as MockedFunction<
  (companyId: string, id: string, userId: string) => Promise<{ id: string }>
>;
const mockGetInvoice = getSupplierInvoiceById as unknown as MockedFunction<
  (companyId: string, id: string) => Promise<Record<string, unknown> | null>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const JOURNAL_ID = 'dddddddd-0000-4000-8000-dddddddddddd';
const REVERSAL_ID = 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: 'approved',
    glJournalEntryId: JOURNAL_ID,
    ...overrides,
  };
}

describe('cancelSupplierInvoice GL reversal (P1.1 sweep / audit C1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverses the approval journal before flipping status', async () => {
    mockGetInvoice.mockResolvedValueOnce(invoice());
    mockReverse.mockResolvedValueOnce({ id: REVERSAL_ID });
    mockSql.mockResolvedValueOnce([{ id: INVOICE_ID, status: 'cancelled' }]);

    await cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).toHaveBeenCalledWith(COMPANY_ID, JOURNAL_ID, USER_ID);
    expect(mockReverse.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSql.mock.invocationCallOrder[0]!,
    );
  });

  it('propagates reversal failure and never flips status', async () => {
    mockGetInvoice.mockResolvedValueOnce(invoice());
    mockReverse.mockRejectedValueOnce(new Error('Fiscal period is closed'));

    await expect(cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /period/i,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('still blocks cancelling invoices with payments', async () => {
    mockGetInvoice.mockResolvedValueOnce(invoice({ status: 'paid' }));

    await expect(cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /payment/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('blocks re-cancelling an already-cancelled invoice', async () => {
    mockGetInvoice.mockResolvedValueOnce(invoice({ status: 'cancelled', glJournalEntryId: null }));

    await expect(cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /already cancelled/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('cancels an unposted invoice (no journal) without attempting a reversal', async () => {
    mockGetInvoice.mockResolvedValueOnce(invoice({ status: 'pending', glJournalEntryId: undefined }));
    mockSql.mockResolvedValueOnce([{ id: INVOICE_ID, status: 'cancelled' }]);

    await cancelSupplierInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
