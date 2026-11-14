/**
 * The reallocation credit ceiling, both sides, judged by the LOWEST running credit from the cancelled document's
 * date onward (ar/customerVoidCredit, bank/bankReallocationCredit). The SQL is proven on a real ledger in
 * tests/integration/bank-reallocate-breaker{,-r2}.int.test.ts; here the decision on its figures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/ar/customerCreditLock', () => ({ tryLockCustomerCredit: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierCreditLock', () => ({ lockSupplierCredit: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierOnAccountCredit', () => ({ getSupplierOnAccountCredit: vi.fn() }));

import { customerVoidCreditShortfall } from '@/modules/accounting/services/ar/customerVoidCredit';
import { assertReallocationKeepsCredit } from '@/modules/accounting/services/bank/bankReallocationCredit';
import { BankReallocationRefusal } from '@/modules/accounting/services/bank/bankReallocationGuards';
import { tryLockCustomerCredit } from '@/modules/accounting/services/ar/customerCreditLock';
import { lockSupplierCredit } from '@/modules/accounting/services/ap/supplierCreditLock';
import { getSupplierOnAccountCredit } from '@/modules/accounting/services/ap/supplierOnAccountCredit';

const sqlText = (i: number) => (sqlMock.mock.calls[i]![0] as TemplateStringsArray).join('?');
beforeEach(() => { vi.clearAllMocks(); sqlMock.mockReset(); });

describe('customerVoidCreditShortfall', () => {
  it('a later-dated receipt does not hide a refund left uncovered on its own date (breaker R2-2)', async () => {
    sqlMock
      .mockResolvedValueOnce([{ customer_id: 'c', lowers: 850 }])
      // all dates would read 850 (a later receipt); the lowest from 07-12 is 0 (the refund's date)
      .mockResolvedValueOnce([{ customer_name: 'Acme', from_date: '2026-07-12', lowers: 850, lowest: 0, lowest_after: -850 }]);
    const s = await customerVoidCreditShortfall('co', ['r1']);
    expect(s).toEqual({ customerId: 'c', customerName: 'Acme', lowers: 850, credit: 0, fromDate: '2026-07-12' });
    expect(tryLockCustomerCredit).toHaveBeenCalledWith('co', 'c');
    expect(sqlText(1)).toMatch(/SUM\(amount\) OVER w/);
  });
  it('passes when the running credit stays at or above zero, and skips customers whose receipts lower nothing', async () => {
    sqlMock
      .mockResolvedValueOnce([{ customer_id: 'c', lowers: 850 }, { customer_id: 'd', lowers: 0 }])
      .mockResolvedValueOnce([{ customer_name: 'Acme', from_date: '2026-07-12', lowers: 850, lowest: 850, lowest_after: 0 }]);
    expect(await customerVoidCreditShortfall('co', ['r1', 'r2'])).toBeNull();
    expect(tryLockCustomerCredit).toHaveBeenCalledTimes(1);
    expect(await customerVoidCreditShortfall('co', [])).toBeNull();
  });
});

describe('assertReallocationKeepsCredit', () => {
  it('supplier side: judged by lowestFromDate as at the payment date, under the credit key', async () => {
    sqlMock.mockResolvedValueOnce([{ supplier_id: 's', from_date: '2026-06-10', lowers: 400 }]);
    vi.mocked(getSupplierOnAccountCredit).mockResolvedValue({ credit: 400, creditAllDates: 400, lowestFromDate: 0, supplierName: 'Sup' });
    await expect(assertReallocationKeepsCredit('co', { supplierPaymentIds: ['p1'], customerPaymentIds: [] }))
      .rejects.toThrow(BankReallocationRefusal);
    expect(lockSupplierCredit).toHaveBeenCalledWith('co', 's');
    expect(getSupplierOnAccountCredit).toHaveBeenCalledWith('co', 's', '2026-06-10');
  });
  it('supplier side passes when the lowest running credit covers it', async () => {
    sqlMock.mockResolvedValueOnce([{ supplier_id: 's', from_date: '2026-06-10', lowers: 400 }]);
    vi.mocked(getSupplierOnAccountCredit).mockResolvedValue({ credit: 400, creditAllDates: 0, lowestFromDate: 400, supplierName: 'Sup' });
    await expect(assertReallocationKeepsCredit('co', { supplierPaymentIds: ['p1'], customerPaymentIds: [] })).resolves.toBeUndefined();
  });
  it('customer side refuses with the customer named', async () => {
    sqlMock
      .mockResolvedValueOnce([{ customer_id: 'c', lowers: 850 }])
      .mockResolvedValueOnce([{ customer_name: 'Acme', from_date: '2026-07-12', lowers: 850, lowest: 0, lowest_after: -850 }]);
    await expect(assertReallocationKeepsCredit('co', { supplierPaymentIds: [], customerPaymentIds: ['r1'] }))
      .rejects.toThrow(/leave Acme owing the company/);
  });
});
