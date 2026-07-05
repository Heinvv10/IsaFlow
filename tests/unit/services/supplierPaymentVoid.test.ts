// RED phase — written before implementation (A–Z programme P2.1, audit W4)
/**
 * voidSupplierPayment — the explicit reversal path for PROCESSED supplier
 * payments (audit W4: "processed supplier payments have no reverse/cancel —
 * mistaken entries can't be cleanly removed").
 *
 * Smallest correct fix: void = reverse the payment's GL journal (metadata
 * semantics), un-apply its allocations (amount_paid rolls back, invoice
 * status recomputed), and set the payment to the existing 'cancelled'
 * status (no schema change). Only 'processed' payments are voidable —
 * reconciled ones are anchored to a bank rec and must be un-reconciled first.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => String(d ?? ''),
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

vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  getSupplierPaymentById: vi.fn(),
}));

import { sql, withSavepoint } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSupplierPaymentById } from '@/modules/accounting/services/ap/supplierPaymentService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockReverse = reverseJournalEntry as unknown as MockedFunction<
  (c: string, i: string, u: string) => Promise<{ id: string }>
>;
const mockGetPayment = getSupplierPaymentById as unknown as MockedFunction<
  (c: string, i: string) => Promise<Record<string, unknown> | null>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const PAYMENT_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const JOURNAL_ID = 'dddddddd-0000-4000-8000-dddddddddddd';
const INVOICE_ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    status: 'processed',
    totalAmount: 115,
    glJournalEntryId: JOURNAL_ID,
    allocations: [{ invoiceId: INVOICE_ID, amountAllocated: 115 }],
    ...overrides,
  };
}

describe('voidSupplierPayment (P2.1 / audit W4)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([{ id: PAYMENT_ID, status: 'cancelled' }]);
    mockReverse.mockResolvedValue({ id: 'je-rev' });
  });

  it('reverses the GL journal, un-applies allocations, and cancels the payment', async () => {
    mockGetPayment.mockResolvedValue(payment());
    const calls: Array<{ text: string; values: unknown[] }> = [];
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      calls.push({ text, values });
      if (/SELECT status, reversed_at/i.test(text)) {
        return Promise.resolve([{ status: 'posted', reversed_at: null }]);
      }
      return Promise.resolve([{ id: PAYMENT_ID, status: 'cancelled' }]);
    });

    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(mockReverse).toHaveBeenCalledWith(COMPANY_ID, JOURNAL_ID, USER_ID);
    const allocUpdate = calls.find((c) => /UPDATE supplier_invoices/i.test(c.text));
    expect(allocUpdate, 'allocations must be un-applied').toBeTruthy();
    expect(allocUpdate!.text).toMatch(/amount_paid - /);
    const payUpdate = calls.find((c) => /UPDATE supplier_payments/i.test(c.text));
    expect(payUpdate!.text).toMatch(/'cancelled'/);
    expect(payUpdate!.text).toMatch(/status = 'processed'/); // guarded flip
  });

  it('rejects voiding a non-processed payment', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'draft', glJournalEntryId: undefined }));

    await expect(voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID)).rejects.toThrow(
      /processed/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('rejects voiding a reconciled payment', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'reconciled' }));

    await expect(voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID)).rejects.toThrow(
      /reconcil/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('runs inside a savepoint (4xx paths must not orphan-commit)', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'draft' }));
    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID).catch(() => undefined);

    expect(withSavepoint).toHaveBeenCalledWith('void_supplier_payment', expect.any(Function));
  });

  it('skips the GL reversal when the journal is already reversed', async () => {
    mockGetPayment.mockResolvedValue(payment());
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SELECT status, reversed_at/i.test(text)) {
        return Promise.resolve([{ status: 'posted', reversed_at: '2026-07-01' }]);
      }
      return Promise.resolve([{ id: PAYMENT_ID, status: 'cancelled' }]);
    });

    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
  });
});
