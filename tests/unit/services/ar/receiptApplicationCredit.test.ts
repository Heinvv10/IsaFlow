/**
 * `planReceiptApplication` asks the receipt credit ceiling (ar/customerVoidCredit): applying
 * an EXISTING receipt's remainder a refund already returned is refused in the plan — so before any write, and in a dry
 * run exactly as live — after the receipt row and the invoice locks (payments → invoices → customers). A receipt the
 * request itself recorded is not asked. The rule's SQL and the routes are proven in
 * tests/integration/ar-receipt-application-after-refund.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/paymentLock', () => ({
  lockCustomerPaymentForUpdate: vi.fn(async () => {
    order.push('receipt');
    return { id: 'p', payment_number: 'CP-1', client_id: 'cust', total_amount: '500', status: 'confirmed', allocated_amount: '0' };
  }),
}));
vi.mock('@/modules/accounting/services/ar/receiptAllocationLines', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/receiptAllocationLines')>()),
  planAllocationLines: vi.fn(async () => { order.push('invoices'); return { customerId: 'cust', lines: [] }; }),
}));
vi.mock('@/modules/accounting/services/ar/customerVoidCredit', () => ({
  assertReceiptApplicationKeepsCredit: vi.fn(async () => { order.push('credit'); }),
}));

import { planReceiptApplication } from '@/modules/accounting/services/ar/receiptApplicationService';
import { assertReceiptApplicationKeepsCredit } from '@/modules/accounting/services/ar/customerVoidCredit';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';

beforeEach(() => { order.length = 0; vi.mocked(assertReceiptApplicationKeepsCredit).mockClear(); });

describe('planReceiptApplication — the receipt credit ceiling', () => {
  it('asks it for the amount applied, after the receipt and its invoices are locked', async () => {
    await planReceiptApplication('co', 'p', [{ invoiceId: 'i1', amount: 200 }, { invoiceId: 'i2', amount: 100 }]);
    expect(assertReceiptApplicationKeepsCredit).toHaveBeenCalledWith('co', 'p', 300);
    expect(order).toEqual(['receipt', 'invoices', 'credit']);
  });
  it('a refusal fails the plan, so a dry run refuses what the live call would', async () => {
    vi.mocked(assertReceiptApplicationKeepsCredit).mockRejectedValueOnce(new ReceiptRefusal('a refund spent it'));
    await expect(planReceiptApplication('co', 'p', [{ invoiceId: 'i1', amount: 200 }])).rejects.toThrow('a refund spent it');
  });
  it('a receipt this request recorded is not asked: it lowers nothing', async () => {
    await planReceiptApplication('co', 'p', [{ invoiceId: 'i1', amount: 200 }], { paymentCreatedInThisRequest: true });
    expect(assertReceiptApplicationKeepsCredit).not.toHaveBeenCalled();
  });
});
