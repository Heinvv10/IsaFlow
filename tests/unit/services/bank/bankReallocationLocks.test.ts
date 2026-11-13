/**
 * The canonical pass's ORDER (bankReallocationLocks): payments -> bills -> invoices -> refund contacts. Contacts last
 * is review round 2: the customer merge takes payments -> invoices -> customers (ar/customerMergeService), so taking
 * the customer first was a 40P01 cycle against it. The SQL itself is exercised on a real ledger in
 * tests/integration/bank-reallocate-reconciled-r1.int.test.ts (crossing contacts, no deadlock).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/core/paymentLock', () => ({
  lockContactForRefund: vi.fn(async (_c: string, kind: string, id: string) => { order.push(`contact:${kind}:${id}`); }),
}));

import { fifoContactOf, lockReallocationDocuments } from '@/modules/accounting/services/bank/bankReallocationLocks';

beforeEach(() => {
  order.length = 0;
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (!/FOR UPDATE/.test(text)) return [];             // a composed fragment
    if (/FROM supplier_payments/.test(text)) { order.push('supplier_payments'); return [{ id: 'p1' }]; }
    if (/FROM customer_payments/.test(text)) { order.push('customer_payments'); return [{ id: 'r1', c: 'cust-b' }]; }
    if (/FROM supplier_invoices/.test(text)) { order.push('bills'); return []; }
    if (/FROM customer_invoices/.test(text)) { order.push('invoices'); return []; }
    return [];
  });
});

describe('lockReallocationDocuments', () => {
  it('payments, then bills, then invoices, then the refund contacts (suppliers, then customers, id order)', async () => {
    const out = await lockReallocationDocuments('co', {
      journalId: 'je', target: { kind: 'customer', customerId: 'cust-a' }, spent: true, autoApply: 'fifo' });
    expect(order).toEqual(['supplier_payments', 'customer_payments', 'bills', 'invoices', 'contact:customer:cust-a',
      'contact:customer:cust-b']);
    expect(out).toEqual({ supplierPaymentIds: ['p1'], customerPaymentIds: ['r1'] });
  });
  it('a supplier refund arm locks the supplier after the documents', async () => {
    await lockReallocationDocuments('co', { journalId: 'je', target: { kind: 'supplier', supplierId: 'sup' }, spent: false, autoApply: 'fifo' });
    expect(order.slice(-2)).toEqual(['contact:supplier:sup', 'contact:customer:cust-b']);
    expect(order.indexOf('contact:supplier:sup')).toBeGreaterThan(order.indexOf('invoices'));
  });
});

describe('fifoContactOf', () => {
  it('names the contact FIFO would settle, only on the paying direction and not under none', () => {
    expect(fifoContactOf({ kind: 'supplier', supplierId: 's' }, true, 'fifo')).toEqual({ kind: 'supplier', id: 's' });
    expect(fifoContactOf({ kind: 'supplier', supplierId: 's' }, false, 'fifo')).toBeNull();
    expect(fifoContactOf({ kind: 'customer', customerId: 'c' }, false, undefined)).toEqual({ kind: 'customer', id: 'c' });
    expect(fifoContactOf({ kind: 'customer', customerId: 'c' }, false, 'none')).toBeNull();
    expect(fifoContactOf({ kind: 'account', glAccountId: 'a' }, true, 'fifo')).toBeNull();
  });
});
