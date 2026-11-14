/**
 * `tryLockCustomerCredit` (ar/customerCreditLock): taken when free, refused at once (retryable) when held, and a
 * customer missing for this company FAILS CLOSED (refused by name). That it never waits on a refund's FOR UPDATE, and that a
 * refund waits on it, is proven on real rows in tests/integration/ar-receipt-{void,application}-after-refund.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { assertCustomerOfCompany, tryLockCustomerCredit } from '@/modules/accounting/services/ar/customerCreditLock';
import { isReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { isPaymentLockTimeout } from '@/modules/accounting/services/core/paymentLock';

beforeEach(() => { sqlMock.mockReset(); });

describe('tryLockCustomerCredit', () => {
  it('takes the row when it is free', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'c' }]);
    await expect(tryLockCustomerCredit('co', 'c')).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
  it('is the customer row, tenant-scoped, NO KEY UPDATE (not KEY SHARE-blocked), never waited on (the text IS the lock)', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'c' }]);
    await tryLockCustomerCredit('co', 'c');
    const text = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/FROM customers c\b/);
    expect(text).toMatch(/c\.company_id = \?::UUID/);
    expect(text).toMatch(/FOR NO KEY UPDATE OF c SKIP LOCKED/);
  });
  it('refuses, retryable, when another request holds the row', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ one: 1 }]);
    expect(isPaymentLockTimeout(await tryLockCustomerCredit('co', 'c').catch((e: unknown) => e))).toBe(true);
  });
  it('FAILS CLOSED: a customer that is not this company\'s is refused by name — not contention, not a silent pass', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const err = await tryLockCustomerCredit('co', 'c').catch((e: unknown) => e);
    expect({ receipt: isReceiptRefusal(err), retry: isPaymentLockTimeout(err) }).toEqual({ receipt: true, retry: false });
    expect((err as Error).message).toMatch(/not one of this company's customers/);
  });
  it('assertCustomerOfCompany: the same refusal, tenant-scoped, for the unlocked (dry-run) judgment', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(assertCustomerOfCompany('co', 'c')).rejects.toThrow(/not one of this company's customers/);
    expect((sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('?')).toMatch(/c\.company_id = \?::UUID/);
    sqlMock.mockResolvedValueOnce([{ one: 1 }]);
    await expect(assertCustomerOfCompany('co', 'c')).resolves.toBeUndefined();
  });
});
