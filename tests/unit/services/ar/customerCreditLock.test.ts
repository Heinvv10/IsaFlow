/**
 * `tryLockCustomerCredit` (ar/customerCreditLock): refused at once (retryable) when held elsewhere; and it says whether
 * THIS call took the row ('acquired') or the transaction already held it ('held') — read off the row's `xmax`, which a
 * re-lock by the holder leaves alone. That it never waits on a refund's FOR UPDATE, that a refund waits on it, and that
 * a rolled-back savepoint makes the next call 'acquired', are proven on real rows in tests/integration/ar-receipt-*.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { tryLockCustomerCredit } from '@/modules/accounting/services/ar/customerCreditLock';
import { isPaymentLockTimeout } from '@/modules/accounting/services/core/paymentLock';

beforeEach(() => { sqlMock.mockReset(); });
const text = (i: number) => (sqlMock.mock.calls[i]![0] as TemplateStringsArray).join('?');

describe('tryLockCustomerCredit', () => {
  it("'acquired' when the lock writes a new xmax", async () => {
    sqlMock.mockResolvedValueOnce([{ xmax: '0' }]).mockResolvedValueOnce([{ id: 'c' }]).mockResolvedValueOnce([{ xmax: '812' }]);
    expect(await tryLockCustomerCredit('co', 'c')).toBe('acquired');
  });
  it("'held' when the row's xmax is unchanged: this transaction already held it", async () => {
    sqlMock.mockResolvedValueOnce([{ xmax: '812' }]).mockResolvedValueOnce([{ id: 'c' }]).mockResolvedValueOnce([{ xmax: '812' }]);
    expect(await tryLockCustomerCredit('co', 'c')).toBe('held');
  });
  it('is the customer row, tenant-scoped, NO KEY UPDATE (not KEY SHARE-blocked), never waited on (the text IS the lock)', async () => {
    sqlMock.mockResolvedValueOnce([{ xmax: '0' }]).mockResolvedValueOnce([{ id: 'c' }]).mockResolvedValueOnce([{ xmax: '9' }]);
    await tryLockCustomerCredit('co', 'c');
    expect(text(1)).toMatch(/FROM customers c\b/);
    expect(text(1)).toMatch(/c\.company_id = \?::UUID/);
    expect(text(1)).toMatch(/FOR NO KEY UPDATE OF c SKIP LOCKED/);
    expect(text(0)).toMatch(/c\.company_id = \?::UUID/);
  });
  it('refuses, retryable, when another request holds the row', async () => {
    sqlMock.mockResolvedValueOnce([{ xmax: '77' }]).mockResolvedValueOnce([]);
    expect(isPaymentLockTimeout(await tryLockCustomerCredit('co', 'c').catch((e: unknown) => e))).toBe(true);
  });
  it('a customer that does not exist for this company is not contention, and takes no lock', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(tryLockCustomerCredit('co', 'c')).resolves.toBe('held');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
