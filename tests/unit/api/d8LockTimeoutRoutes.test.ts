/**
 * D8 round 9 (review rev-d8-9ecdfa549, finding 3): the four blanket-catch routes the reversal-chain flows reach
 * answered the chain head's lock timeout (`JournalReversalLockTimeoutError`) — and a bounded document lock's
 * (`RowLockTimeoutError`) — with 400 "retry in a moment" and no Retry-After, while AP void, batch reversal and
 * dismiss answered 503. Each now answers every lock timeout through `respondIfLockTimeout`: 503 + Retry-After.
 * The other direction is pinned too: an ordinary refusal keeps its 400.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  confirmCustomerPayment: vi.fn(), cancelCustomerPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  matchTransaction: vi.fn(), unmatchTransaction: vi.fn(), excludeTransaction: vi.fn(), autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(), splitAllocateTransaction: vi.fn(), deleteTransactions: vi.fn(),
  bulkAcceptTransactions: vi.fn(), reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  approveSupplierInvoice: vi.fn(), cancelSupplierInvoice: vi.fn(), performThreeWayMatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  approveCreditNote: vi.fn(), cancelCreditNote: vi.fn(), applyCreditNoteToInvoice: vi.fn(),
}));

import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { JournalReversalLockTimeoutError } from '@/modules/accounting/services/gl/journalEntryReversalClaim';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import customerAction from '../../../pages/api/accounting/customer-payments-action';
import bankAction from '../../../pages/api/accounting/bank-transactions-action';
import supplierInvoiceAction from '../../../pages/api/accounting/supplier-invoices-action';
import creditNoteAction from '../../../pages/api/accounting/credit-notes-action';

const ID = '66666666-6666-4666-8666-666666666666';

function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, body: unknown) {
  const req = { method: 'POST', query: {}, body, companyId: '11111111-1111-4111-8111-111111111111',
    user: { id: '99999999-9999-4999-8999-999999999999' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}

const routes = [
  { name: 'customer-payments-action cancel (receipt cancel)', handler: customerAction,
    body: { action: 'cancel', paymentId: ID }, service: () => vi.mocked(cancelCustomerPayment) },
  { name: 'bank-transactions-action reverse (bank reversal)', handler: bankAction,
    body: { action: 'reverse', bankTransactionId: ID }, service: () => vi.mocked(reverseReconciledTransaction) },
  { name: 'supplier-invoices-action cancel (bill cancel)', handler: supplierInvoiceAction,
    body: { action: 'cancel', invoiceId: ID }, service: () => vi.mocked(cancelSupplierInvoice) },
  { name: 'credit-notes-action cancel (credit-note cancel)', handler: creditNoteAction,
    body: { action: 'cancel', creditNoteId: ID }, service: () => vi.mocked(cancelCreditNote) },
] as const;

beforeEach(() => { vi.resetAllMocks(); });

describe.each(routes)('$name', ({ handler, body, service }) => {
  it.each([
    ['the chain head', () => new JournalReversalLockTimeoutError(ID)],
    ['a bounded document lock', () => new RowLockTimeoutError(`Invoice ${ID}`)],
  ])('answers a lock timeout on %s 503 + Retry-After', async (_what, make) => {
    service().mockRejectedValue(make() as never);
    const res = await call(handler as never, body);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/);
  });

  it('still answers an ordinary refusal 400 with its message', async () => {
    service().mockRejectedValue(new Error('Cannot cancel this document') as never);
    const res = await call(handler as never, body);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/Cannot cancel this document/);
  });
});
