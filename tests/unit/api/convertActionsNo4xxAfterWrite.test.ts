/**
 * The two convert actions answer 4xx only for a PRE-WRITE refusal.
 *
 * `withAuth` COMMITs the request transaction on a 4xx and ROLLBACKs only on a
 * 5xx. `customer-sales-orders-action` caught everything and returned
 * `badRequestFromError`, so a conversion that failed after minting the invoice
 * had that partial work committed. Both routes now map only the typed
 * status refusals — raised before the sequence is touched — and rethrow the
 * rest so `withErrorHandler` turns it into a 500 and the transaction rolls back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ar/salesOrderService', () => ({
  confirmSalesOrder: vi.fn(),
  convertSalesOrderToInvoice: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({
  updateQuoteStatus: vi.fn(),
  convertToInvoice: vi.fn(),
  convertToSalesOrder: vi.fn(),
}));

import { convertSalesOrderToInvoice } from '@/modules/accounting/services/ar/salesOrderService';
import { SalesOrderNotInvoiceableError } from '@/modules/accounting/services/ar/salesOrderWorkflowService';
import { convertToInvoice } from '@/modules/accounting/services/ar/quoteService';
import { QuoteNotInvoiceableError } from '@/modules/accounting/services/ar/quoteConvertService';
import orderHandler from '../../../pages/api/accounting/customer-sales-orders-action';
import quoteHandler from '../../../pages/api/accounting/customer-quotes-action';

const mockOrder = convertSalesOrderToInvoice as unknown as ReturnType<typeof vi.fn>;
const mockQuote = convertToInvoice as unknown as ReturnType<typeof vi.fn>;

function makeRes() {
  const res = { statusCode: 200 } as unknown as NextApiResponse & { body?: unknown };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = vi.fn((b: unknown) => { (res as { body?: unknown }).body = b; return res; }) as never;
  return res;
}

const post = (action: string) => ({
  method: 'POST',
  user: { id: 'u1' },
  companyId: 'c1',
  body: { id: 'd1', action },
} as unknown as NextApiRequest);

beforeEach(() => vi.clearAllMocks());

describe('customer-sales-orders-action invoice', () => {
  it('answers 409 with the winner\'s invoice id when the order is already invoiced', async () => {
    mockOrder.mockRejectedValueOnce(new SalesOrderNotInvoiceableError('invoiced', 'inv-1'));
    const res = makeRes();
    await orderHandler(post('invoice') as never, res as never);
    expect.soft(res.statusCode).toBe(409);
    expect((res as { body?: { error?: { details?: unknown } } }).body?.error?.details)
      .toMatchObject({ orderStatus: 'invoiced', invoiceId: 'inv-1' });
  });

  it('propagates any other failure so the request transaction rolls back', async () => {
    const dbError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockOrder.mockRejectedValueOnce(dbError);
    const res = makeRes();
    await expect(orderHandler(post('invoice') as never, res as never)).rejects.toBe(dbError);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('customer-quotes-action convert', () => {
  it('answers 409 with the winner\'s invoice id when the quote is already converted', async () => {
    mockQuote.mockRejectedValueOnce(new QuoteNotInvoiceableError('converted', 'inv-9'));
    const res = makeRes();
    await quoteHandler(post('convert') as never, res as never);
    expect.soft(res.statusCode).toBe(409);
    expect((res as { body?: { error?: { details?: unknown } } }).body?.error?.details)
      .toMatchObject({ quoteStatus: 'converted', invoiceId: 'inv-9' });
  });

  it('propagates any other failure so the request transaction rolls back', async () => {
    const boom = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    mockQuote.mockRejectedValueOnce(boom);
    const res = makeRes();
    await expect(quoteHandler(post('convert') as never, res as never)).rejects.toBe(boom);
    expect(res.json).not.toHaveBeenCalled();
  });
});
