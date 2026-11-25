/**
 * Intercompany P4-B: `applySupplierPaymentPlan` hands the allocation rows it wrote (INSERT ... RETURNING id) to the payer's allocation
 * outbox, AFTER the payment's status write, once per application, and only the ids the database returned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  mirror: vi.fn(async (..._a: unknown[]) => undefined),
  applyLine: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('@/lib/neon', async () => ({ ...(await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon')), sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/paymentLock', () => ({ lockSupplierPaymentForUpdate: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierCreditLock', () => ({ lockSupplierCredit: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierOnAccountCredit', () => ({ getSupplierOnAccountCredit: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/allocationOutbox', () => ({ mirrorAllocations: m.mirror }));
vi.mock('@/modules/accounting/services/ap/supplierAllocationLines', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ap/supplierAllocationLines')>()), applyLineToBill: m.applyLine,
}));

import { applySupplierPaymentPlan, type SupplierPaymentApplicationPlan } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const line = (invoiceId: string) => ({ invoiceId, amount: 100 } as never);
const plan = (invoices: string[]): SupplierPaymentApplicationPlan => ({
  paymentId: PAYMENT, paymentNumber: 'PAY1', supplierId: 's', paymentTotal: 1000, allocatedBefore: 0, allocatedAfter: 100 * invoices.length,
  unappliedBefore: 1000, unappliedAfter: 1000 - 100 * invoices.length, paymentStatusBefore: 'processed', paymentStatusAfter: 'processed',
  lines: invoices.map(line), postsJournal: false,
});
const text = (call: unknown[]) => (call[0] as string[]).join('?');

beforeEach(() => { vi.clearAllMocks(); });

describe('applySupplierPaymentPlan -> the payer\'s allocation outbox', () => {
  it('returns the id of each allocation row it inserts and calls the hook with them AFTER the payment\'s status write', async () => {
    m.sql.mockImplementation(async (...a: unknown[]) => (text(a).includes('INSERT INTO payment_allocations')
      ? [{ id: `alloc-${m.sql.mock.calls.filter((c) => text(c).includes('INSERT INTO payment_allocations')).length}` }] : []));
    await applySupplierPaymentPlan(COMPANY, plan(['bill-a', 'bill-b']), 'user');
    const sqls = m.sql.mock.calls.map(text);
    expect(sqls.find((t) => t.includes('INSERT INTO payment_allocations'))).toMatch(/RETURNING id/);
    expect(m.mirror).toHaveBeenCalledTimes(1);
    expect(m.mirror).toHaveBeenCalledWith(COMPANY, ['alloc-1', 'alloc-2']);
    const statusWrite = sqls.findIndex((t) => t.includes('UPDATE supplier_payments'));
    expect(statusWrite).toBeGreaterThan(-1);
    expect(m.mirror.mock.invocationCallOrder[0]).toBeGreaterThan(m.sql.mock.invocationCallOrder[statusWrite]!);
    expect(m.mirror.mock.invocationCallOrder[0]).toBeGreaterThan(m.applyLine.mock.invocationCallOrder[1]!);
  });

  it('names only ids the database returned: a plan with no lines does not call the hook', async () => {
    m.sql.mockResolvedValue([]);
    await applySupplierPaymentPlan(COMPANY, plan([]), 'user');
    expect(m.mirror).not.toHaveBeenCalled();
  });
});
