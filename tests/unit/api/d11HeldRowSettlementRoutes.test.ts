/**
 * D11, the settlement routes the first census missed (they catch `isRetryable*Refusal` directly, not a typed lock
 * error): a bill or invoice a peer holds answers 503 + Retry-After, a retryable STATE conflict keeps its 409.
 *   batch-payments POST, supplier-payments POST, ar/receipt-match/confirm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/batchPaymentService', async (orig) => ({ ...(await orig<object>()), createBatch: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', async (orig) => ({
  ...(await orig<object>()), createSupplierPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', async (orig) => ({
  ...(await orig<object>()), validateBankReceiptApplication: vi.fn(),
}));

import { createBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { createSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';
import { validateBankReceiptApplication } from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import batchPayments from '../../../pages/api/accounting/batch-payments';
import supplierPayments from '../../../pages/api/accounting/supplier-payments';
import receiptMatchConfirm from '../../../pages/api/accounting/ar/receipt-match/confirm';

const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function call(handler: Handler, body: unknown) {
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
type Res = Awaited<ReturnType<typeof call>>;
const expectHeld = (res: Res) => { expect(res.statusCode).toBe(503); expect(res.headers['Retry-After']).toBe('2'); };
const expectState = (res: Res) => { expect(res.statusCode).toBe(409); expect(res.headers['Retry-After']).toBeUndefined(); };

const heldBill = () => new SupplierPaymentRefusal('Another request is paying one of these bills — retry in a moment.',
  { retryable: true, held: true });
const stateBill = () => new SupplierPaymentRefusal('changed — retry in a moment.', { retryable: true });
const heldInvoice = () => new ReceiptRefusal('Another request is applying cash to one of these invoices — retry in a moment.',
  { retryable: true, held: true });
const stateInvoice = () => new ReceiptRefusal('changed — retry in a moment.', { retryable: true });

beforeEach(() => { vi.clearAllMocks(); });

describe('D11 batch-payments POST', () => {
  it('a held bill -> 503 + Retry-After (was 409)', async () => {
    vi.mocked(createBatch).mockRejectedValueOnce(heldBill());
    expectHeld(await call(batchPayments, {}));
  });
  it('a retryable state conflict keeps 409', async () => {
    vi.mocked(createBatch).mockRejectedValueOnce(stateBill());
    expectState(await call(batchPayments, {}));
  });
});

describe('D11 supplier-payments POST', () => {
  const body = { supplierId: ID, paymentDate: '2026-09-01', totalAmount: 10, allocations: [{ invoiceId: ID, amount: 10 }] };
  it('a held bill -> 503 + Retry-After (was 409)', async () => {
    vi.mocked(createSupplierPayment).mockRejectedValueOnce(heldBill());
    expectHeld(await call(supplierPayments, body));
  });
  it('a retryable state conflict keeps 409', async () => {
    vi.mocked(createSupplierPayment).mockRejectedValueOnce(stateBill());
    expectState(await call(supplierPayments, body));
  });
});

describe('D11 ar/receipt-match/confirm', () => {
  const body = { bankTxId: ID, customerInvoiceId: ID, amount: 10 };
  it('a held invoice -> 503 + Retry-After (was 409)', async () => {
    vi.mocked(validateBankReceiptApplication).mockRejectedValueOnce(heldInvoice());
    expectHeld(await call(receiptMatchConfirm, body));
  });
  it('a retryable state conflict keeps 409', async () => {
    vi.mocked(validateBankReceiptApplication).mockRejectedValueOnce(stateInvoice());
    expectState(await call(receiptMatchConfirm, body));
  });
});
