/**
 * The two customer-invoice routes, for line coding (migration 874): create
 * passes the header projectId through and answers a coding refusal 400 with
 * INVOICE_LINE_CODING_REFUSED; the detail route answers a draft edit's
 * `bad_line` and approve's pre-write refusal the same way, and RETHROWS a
 * refusal raised after approve's status UPDATE (ArPostingAfterWriteError) so
 * withAuth rolls back instead of committing a 400.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-error-handler')>()),
  withErrorHandler: (fn: unknown) => fn,
}));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    created: vi.fn((_r: unknown, data: unknown) => ({ kind: 'created', data })),
    badRequest: vi.fn((_r: unknown, error: string, details?: unknown) => ({ kind: 'badRequest', error, details })),
    conflict: vi.fn(() => ({ kind: 'conflict' })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    validationError: vi.fn((_r: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    error: vi.fn(() => ({ kind: 'error' })),
  },
  ErrorCode: { SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE', INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR' },
}));
const m = vi.hoisted(() => ({ create: vi.fn(), edit: vi.fn(), approve: vi.fn(), quote: vi.fn(), updateQuote: vi.fn(), convert: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/quoteService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/quoteService')>()),
  createQuote: m.quote, updateQuote: m.updateQuote, convertToInvoice: m.convert,
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerInvoiceCreateService')>()),
  createDraftCustomerInvoice: m.create,
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceDraftEdit', () => ({ editDraftCustomerInvoice: m.edit }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerInvoiceApprovalService')>()),
  approveCustomerInvoice: m.approve,
}));

import createHandler from '../../../../pages/api/accounting/customer-invoices-create';
import quotesHandler from '../../../../pages/api/accounting/customer-quotes';
import quoteActionHandler from '../../../../pages/api/accounting/customer-quotes-action';
import detailHandler from '../../../../pages/api/accounting/customer-invoices-detail';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { ArPostingAfterWriteError } from '@/modules/accounting/services/ar/arErrors';
import { InvoiceLineAccountLockError } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { respondToUnhandledError } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';

type Out = { kind: string; error?: string; details?: unknown; data?: unknown };
const run = (h: unknown, method: string, body: unknown) =>
  (h as (r: NextApiRequest, s: NextApiResponse) => Promise<Out>)(
    { method, body, companyId: 'company-1', user: { id: 'user-1' } } as unknown as NextApiRequest,
    {} as NextApiResponse);

const CLIENT = '33333333-3333-4333-8333-333333333333';
const PROJECT = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const INV = '11111111-1111-4111-8111-111111111111';
const REFUSED = 'An invoice line cannot be coded to 6100 Crew: it is not a revenue account (it is expense).';

beforeEach(() => vi.clearAllMocks());

describe('POST customer-invoices-create', () => {
  it('passes the header projectId to the service', async () => {
    m.create.mockResolvedValueOnce({ id: INV, invoiceNumber: 'INV-1' });
    await run(createHandler, 'POST', { clientId: CLIENT, projectId: PROJECT, items: [{ description: 'x', unitPrice: 1 }] });
    expect(m.create.mock.calls[0]![2]).toMatchObject({ clientId: CLIENT, projectId: PROJECT });
  });

  it('answers a coding refusal 400 with INVOICE_LINE_CODING_REFUSED', async () => {
    m.create.mockRejectedValueOnce(new InvoiceLineCodingRefusal(REFUSED));
    expect(await run(createHandler, 'POST', { clientId: CLIENT, items: [{ description: 'x', unitPrice: 1 }] }))
      .toEqual({ kind: 'badRequest', error: REFUSED, details: { code: 'INVOICE_LINE_CODING_REFUSED' } });
  });
});

describe('customer-invoices-detail', () => {
  it('PUT answers bad_line 400 with INVOICE_LINE_CODING_REFUSED', async () => {
    m.edit.mockResolvedValueOnce({ kind: 'bad_line', message: REFUSED });
    expect(await run(detailHandler, 'PUT', { id: INV, items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }))
      .toEqual({ kind: 'badRequest', error: REFUSED, details: { code: 'INVOICE_LINE_CODING_REFUSED' } });
  });

  it('approve answers the pre-write refusal 400 with INVOICE_LINE_CODING_REFUSED', async () => {
    m.approve.mockRejectedValueOnce(new InvoiceLineCodingRefusal(REFUSED));
    expect(await run(detailHandler, 'POST', { id: INV, action: 'approve' }))
      .toEqual({ kind: 'badRequest', error: REFUSED, details: { code: 'INVOICE_LINE_CODING_REFUSED' } });
  });

  it('approve RETHROWS a refusal raised after its status UPDATE, so withAuth rolls back', async () => {
    m.approve.mockRejectedValueOnce(new ArPostingAfterWriteError(REFUSED));
    await expect(run(detailHandler, 'POST', { id: INV, action: 'approve' })).rejects.toBeInstanceOf(ArPostingAfterWriteError);
  });
});

describe('a forced 40P01 on the line-account lock, through the routes', () => {
  const deadlock = () => new InvoiceLineAccountLockError({ cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }) });
  const send = (h: unknown, method: string, body: unknown, res: NextApiResponse) =>
    (h as (r: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(
      { method, body, companyId: 'company-1', user: { id: 'user-1' } } as unknown as NextApiRequest, res);

  it.each([
    ['approve', () => m.approve.mockRejectedValueOnce(deadlock()), detailHandler, 'POST', { id: INV, action: 'approve' }],
    ['draft edit', () => m.edit.mockRejectedValueOnce(deadlock()), detailHandler, 'PUT', { id: INV, items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }],
    ['create', () => m.create.mockRejectedValueOnce(deadlock()), createHandler, 'POST', { clientId: CLIENT, items: [{ description: 'x', unitPrice: 1 }] }],
  ] as const)('%s never answers it 4xx: it reaches the 503 retryable answer, which rolls back', async (_s, arm, h, method, body) => {
    arm();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() } as unknown as NextApiResponse;
    // A route either answers it itself (respondIfLockTimeout) or rethrows it to withErrorHandler's answer.
    await send(h, method, body, res).catch((err: unknown) => respondToUnhandledError(res, err));
    expect(apiResponse.badRequest).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(apiResponse.error).toHaveBeenCalledWith(res, 'SERVICE_UNAVAILABLE', expect.stringMatching(/retry in a moment/),
      { code: 'INVOICE_LINE_ACCOUNT_LOCK_TIMEOUT' });
  });
});

describe('quotes: a line account the invoice could never post to', () => {
  it('POST customer-quotes answers it 400 with INVOICE_LINE_CODING_REFUSED', async () => {
    m.quote.mockRejectedValueOnce(new InvoiceLineCodingRefusal(REFUSED));
    expect(await run(quotesHandler, 'POST', { customerName: 'x', lines: [] }))
      .toEqual({ kind: 'badRequest', error: REFUSED, details: { code: 'INVOICE_LINE_CODING_REFUSED' } });
  });

  it('PUT customer-quotes answers it 400 with INVOICE_LINE_CODING_REFUSED', async () => {
    m.updateQuote.mockRejectedValueOnce(new InvoiceLineCodingRefusal(REFUSED));
    expect(await run(quotesHandler, 'PUT', { id: INV, customerName: 'x', lines: [] }))
      .toEqual({ kind: 'badRequest', error: REFUSED, details: { code: 'INVOICE_LINE_CODING_REFUSED' } });
  });

  it('convert answers it 400 with INVOICE_LINE_CODING_REFUSED', async () => {
    m.convert.mockRejectedValueOnce(new InvoiceLineCodingRefusal(REFUSED));
    expect(await run(quoteActionHandler, 'POST', { id: INV, action: 'convert' }))
      .toEqual({ kind: 'badRequest', error: REFUSED, details: { code: 'INVOICE_LINE_CODING_REFUSED' } });
  });
});
