/**
 * The reallocation credit ceiling, both sides, judged by the LOWEST running credit from the cancelled document's
 * date onward (ar/customerVoidCredit, bank/bankReallocationCredit). The SQL is proven on a real ledger in
 * tests/integration/bank-reallocate-breaker{,-r2}.int.test.ts; here the decision on its figures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
// The customer figure (ar/customerVoidCredit) has its own tests; here the reallocation's decision and wording on it.
vi.mock('@/modules/accounting/services/ar/customerVoidCredit', () => ({ customerVoidCreditShortfall: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/ap/supplierCreditLock', () => ({ lockSupplierCredit: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierOnAccountCredit', () => ({ getSupplierOnAccountCredit: vi.fn() }));

import { customerVoidCreditShortfall } from '@/modules/accounting/services/ar/customerVoidCredit';
import { assertReallocationKeepsCredit } from '@/modules/accounting/services/bank/bankReallocationCredit';
import { BankReallocationRefusal } from '@/modules/accounting/services/bank/bankReallocationGuards';
import { lockSupplierCredit } from '@/modules/accounting/services/ap/supplierCreditLock';
import { getSupplierOnAccountCredit } from '@/modules/accounting/services/ap/supplierOnAccountCredit';

beforeEach(() => { vi.clearAllMocks(); sqlMock.mockReset(); });

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
  it('customer side refuses with the customer named, the figures and the date', async () => {
    vi.mocked(customerVoidCreditShortfall).mockResolvedValueOnce({ customerId: 'c', customerName: 'Acme', lowers: 850, credit: 0, fromDate: '2026-07-12' });
    await expect(assertReallocationKeepsCredit('co', { supplierPaymentIds: [], customerPaymentIds: ['r1'] }))
      .rejects.toThrow(/cancel its receipt and leave Acme owing the company: .* from 2026-07-12/);
    expect(customerVoidCreditShortfall).toHaveBeenCalledWith('co', ['r1']);
  });
});
