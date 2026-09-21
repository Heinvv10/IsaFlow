/**
 * Applying a bank receipt to the customer's open invoices, on the customer's
 * own instruction.
 *
 * The AR half was never as broken as AP — `allocateTransaction` did at least
 * create the `customer_payments` row, which is why the unapplied receipts
 * balance is a known number rather than an invisible one. What was missing is
 * the same: the instruction to apply it lived in a column nothing read.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), getPoolForTests: vi.fn() }));
// The locking open-document read bounds its wait with SET LOCAL lock_timeout,
// which needs the request's own client — the same shape fetchBillCandidates
// uses. Its SQL shape and lock order are asserted in
// tests/unit/services/ap/openDocumentLock.test.ts.
vi.mock('@/modules/accounting/services/core/requestTransaction', () => ({
  requireRequestTransaction: () => ({ query: vi.fn(async () => undefined) }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/receiptApplicationService', () => ({
  planReceiptApplication: vi.fn(),
  applyReceiptPlan: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  planReceiptApplication,
  applyReceiptPlan,
} from '@/modules/accounting/services/ar/receiptApplicationService';
import {
  autoApplyCustomerReceipt,
} from '@/modules/accounting/services/ar/customerAutoAllocate';

type SqlFn = MockedFunction<(strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockPlan = planReceiptApplication as MockedFunction<typeof planReceiptApplication>;
const mockApply = applyReceiptPlan as MockedFunction<typeof applyReceiptPlan>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_ID = '22222222-2222-2222-2222-222222222222';
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';

const ARGS = {
  companyId: COMPANY_ID,
  customerId: CUSTOMER_ID,
  paymentId: PAYMENT_ID,
  journalEntryId: 'je-1',
  amount: 500,
  userId: USER_ID,
};

function queries(): string[] {
  return mockSql.mock.calls.map(([s]) => s.join('?').replace(/\s+/g, ' ').trim());
}

beforeEach(() => vi.clearAllMocks());

describe('autoApplyCustomerReceipt', () => {
  it("leaves the receipt unapplied on autoApply 'none', without reading the customer", async () => {
    const result = await autoApplyCustomerReceipt({ ...ARGS, autoApply: 'none' });

    expect(mockPlan).not.toHaveBeenCalled();
    expect(result.unappliedRemainder).toBe(500);
    expect(result.autoApply).toBe('none');
    // Neither the customer nor the invoices are read — the mode decides first.
    expect(queries().some((q) => q.includes('FROM customers'))).toBe(false);
    expect(queries().some((q) => q.includes('FROM customer_invoices'))).toBe(false);
  });

  it("applies FIFO even when the customer column says 'off'", async () => {
    mockSql
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'off' }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([]);

    const result = await autoApplyCustomerReceipt(ARGS);

    // 'off' is the column default nobody set; it reads as "no preference", and
    // the invoices ARE consulted now.
    expect(result.strategy).toBe('oldest');
    expect(queries().some((q) => q.includes('FROM customer_invoices'))).toBe(true);
  });

  it('applies oldest-first, partially settling the invoice the cash runs out on', async () => {
    mockSql
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([
        // id order from the database; the FIFO order is applied in memory.
        { id: 'inv-new', invoice_date: '2026-02-09', due_date: null, outstanding: 800 },
        { id: 'inv-old', invoice_date: '2026-02-01', due_date: null, outstanding: 200 },
      ]);
    mockPlan.mockResolvedValue({
      paymentId: PAYMENT_ID, paymentNumber: 'RC-1', customerId: CUSTOMER_ID,
      paymentTotal: 500, allocatedBefore: 0, allocatedAfter: 500,
      unappliedBefore: 500, unappliedAfter: 0,
      paymentStatusBefore: 'confirmed', paymentStatusAfter: 'reconciled',
      lines: [
        { invoiceId: 'inv-old', invoiceNumber: 'INV-1', amount: 200, outstandingBefore: 200, outstandingAfter: 0, statusBefore: 'sent', statusAfter: 'paid', fullySettled: true },
        { invoiceId: 'inv-new', invoiceNumber: 'INV-2', amount: 300, outstandingBefore: 800, outstandingAfter: 500, statusBefore: 'sent', statusAfter: 'partially_paid', fullySettled: false },
      ],
      postsJournal: false,
    });
    mockApply.mockImplementation(async (_c, plan) => plan);

    const result = await autoApplyCustomerReceipt(ARGS);

    expect(mockPlan).toHaveBeenCalledWith(COMPANY_ID, PAYMENT_ID, [
      { invoiceId: 'inv-old', amount: 200 },
      { invoiceId: 'inv-new', amount: 300 },
    ]);
    expect(result.appliedLines).toHaveLength(2);
    expect(result.unappliedRemainder).toBe(0);
  });

  it('does nothing when the customer has nothing open', async () => {
    mockSql
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'newest' }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([]);

    const result = await autoApplyCustomerReceipt(ARGS);

    expect(mockPlan).not.toHaveBeenCalled();
    expect(result.unappliedRemainder).toBe(500);
  });

  it('does not swallow a failure from the applier', async () => {
    mockSql
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ id: 'inv-old', outstanding: 200 }]);
    mockPlan.mockRejectedValue(new Error('Cannot apply a cancelled payment.'));

    await expect(autoApplyCustomerReceipt(ARGS)).rejects.toThrow(/cancelled payment/);
  });
});

describe('autoApplyCustomerReceipt — the journal is in no fiscal period', () => {
  it('applies nothing, leaving the receipt for a human', async () => {
    mockSql
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([{ fiscal_period_id: null }]);

    const result = await autoApplyCustomerReceipt(ARGS);

    expect(mockPlan).not.toHaveBeenCalled();
    expect(result.unappliedRemainder).toBe(500);
    // The invoices are never read: the journal decides before they are.
    expect(queries().some((q) => q.includes('FROM customer_invoices'))).toBe(false);
  });
});
