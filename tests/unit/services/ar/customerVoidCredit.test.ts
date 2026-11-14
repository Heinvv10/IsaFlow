/**
 * The receipt-cancellation credit refusal (ar/customerVoidCredit) and its tried lock (ar/customerCreditLock): the
 * decision on the figures, the wording, and when the lock is taken. The running-credit SQL is proven on a real ledger
 * in tests/integration/ar-receipt-void-after-refund.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import {
  CustomerVoidCreditRefusal, assertReceiptVoidKeepsCredit, isCustomerVoidCreditRefusal,
} from '@/modules/accounting/services/ar/customerVoidCredit';
import { tryLockCustomerCredit } from '@/modules/accounting/services/ar/customerCreditLock';
import { ReceiptRefusal, isReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { isPaymentLockTimeout } from '@/modules/accounting/services/core/paymentLock';
import { safeErrorText } from '@/lib/mcp/tools/toolHelpers';

const sqlText = (i: number) => (sqlMock.mock.calls[i]![0] as TemplateStringsArray).join('?');
beforeEach(() => { sqlMock.mockReset(); });

describe('assertReceiptVoidKeepsCredit', () => {
  it('refuses, naming the customer, what it lowers, the lowest credit and the date, as RECEIPT_REFUSED', async () => {
    sqlMock
      .mockResolvedValueOnce([{ customer_id: 'c', lowers: 1000 }]) // the receipts' customers
      .mockResolvedValueOnce([{ id: 'c' }]) // the tried lock
      .mockResolvedValueOnce([{ customer_name: 'Acme', from_date: '2026-05-05', lowers: 1000, lowest: 0, lowest_after: -1000 }]);
    const err = await assertReceiptVoidKeepsCredit('co', ['r1']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomerVoidCreditRefusal);
    expect(isReceiptRefusal(err)).toBe(true);
    expect(isCustomerVoidCreditRefusal(err)).toBe(true);
    const text = safeErrorText(err, 'fallback');
    expect(text).toMatch(/^Cancelling this receipt would leave Acme owing the company/);
    expect(text).toContain('from 2026-05-05');
    expect(text).toMatch(/R\s?1[\s,]?000\.00 of unapplied cash/);
    expect(text).toMatch(/only R\s?0\.00 is on account/);
    expect(sqlText(1)).toMatch(/FOR NO KEY UPDATE OF c SKIP LOCKED/);
  });

  it('a fully applied receipt lowers nothing: no lock, no credit read, no refusal', async () => {
    sqlMock.mockResolvedValueOnce([{ customer_id: 'c', lowers: 0 }]);
    await expect(assertReceiptVoidKeepsCredit('co', ['r1'])).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('passes when the running credit stays at zero or above on every date it lowers', async () => {
    sqlMock
      .mockResolvedValueOnce([{ customer_id: 'c', lowers: 150 }])
      .mockResolvedValueOnce([{ id: 'c' }])
      // two receipts on different dates: the lowest BEFORE (50) is below what they lower together (150), but each
      // date's figure after the cancellation is 0 — judged by date, not "sum vs lowest"
      .mockResolvedValueOnce([{ customer_name: 'Acme', from_date: '2026-05-05', lowers: 150, lowest: 50, lowest_after: 0 }]);
    await expect(assertReceiptVoidKeepsCredit('co', ['r1', 'r2'])).resolves.toBeUndefined();
    expect(sqlMock.mock.calls[2]).toContainEqual(['r1', 'r2']);
  });

  it('words several receipts as "these receipts"', async () => {
    sqlMock
      .mockResolvedValueOnce([{ customer_id: 'c', lowers: 200 }])
      .mockResolvedValueOnce([{ id: 'c' }])
      .mockResolvedValueOnce([{ customer_name: 'Acme', from_date: '2026-05-05', lowers: 200, lowest: 150, lowest_after: -50 }]);
    await expect(assertReceiptVoidKeepsCredit('co', ['r1', 'r2'])).rejects.toThrow(/^Cancelling these receipts/);
  });

  it('a plain receipt refusal is not the credit refusal (bulk reversals retry only the credit one)', () => {
    expect(isCustomerVoidCreditRefusal(new ReceiptRefusal('x'))).toBe(false);
  });
});

describe('tryLockCustomerCredit', () => {
  it('takes the row when it is free', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'c' }]);
    await expect(tryLockCustomerCredit('co', 'c')).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
  it('refuses, retryable, when another request holds the row — never waits', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ one: 1 }]);
    const err = await tryLockCustomerCredit('co', 'c').catch((e: unknown) => e);
    expect(isPaymentLockTimeout(err)).toBe(true);
    expect(sqlText(0)).toMatch(/SKIP LOCKED/);
  });
  it('a customer that does not exist for this company is not contention', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(tryLockCustomerCredit('co', 'c')).resolves.toBeUndefined();
  });
});
