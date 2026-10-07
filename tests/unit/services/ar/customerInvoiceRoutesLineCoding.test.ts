/**
 * The two customer-invoice routes, for line coding (migration 870): create
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
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    created: vi.fn((_r: unknown, data: unknown) => ({ kind: 'created', data })),
    badRequest: vi.fn((_r: unknown, error: string, details?: unknown) => ({ kind: 'badRequest', error, details })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    validationError: vi.fn((_r: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));
const m = vi.hoisted(() => ({ create: vi.fn(), edit: vi.fn(), approve: vi.fn() }));
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
import detailHandler from '../../../../pages/api/accounting/customer-invoices-detail';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { ArPostingAfterWriteError } from '@/modules/accounting/services/ar/arErrors';

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
