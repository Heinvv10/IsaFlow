/**
 * Unit tests for the POST action guards on
 * /api/accounting/customer-invoices-detail.
 *
 * Covers:
 *  - approve is rejected (400) for an invoice not in {draft, pending_approval}
 *    (e.g. cancelled) — prevents re-adding it to AR against a reversed journal
 *  - approve on a missing invoice → 404
 *  - approve from draft still succeeds and posts GL
 *  - cancel maps ClosedFiscalPeriodError from the reversal to a 400, not a 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn((_res: unknown, entity: string, id: string) => ({ kind: 'notFound', entity, id })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
  },
}));

const { sqlMock, cancelMock, postGlMock, snapshotMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn() }),
  cancelMock: vi.fn(),
  postGlMock: vi.fn(),
  snapshotMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCancelService', () => ({
  cancelCustomerInvoice: cancelMock,
  InvoiceNotFoundError: class InvoiceNotFoundError extends Error {},
  InvoiceHasPaymentsError: class InvoiceHasPaymentsError extends Error {},
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({ postCustomerInvoiceToGL: postGlMock }));
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({ snapshotInvoicePdf: snapshotMock }));

// Real ClosedFiscalPeriodError so the route's instanceof check matches.
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryService';
import handler from '../../../pages/api/accounting/customer-invoices-detail';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const INV_ID = '11111111-1111-4111-8111-111111111111';

function req(body: unknown): NextApiRequest {
  return { method: 'POST', body, companyId: COMPANY_ID, user: { id: USER_ID } } as unknown as NextApiRequest;
}
const call = (body: unknown) =>
  (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<{ kind: string; error?: string }>)(
    req(body),
    {} as NextApiResponse,
  );

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
});

describe('customer-invoices-detail POST action guards', () => {
  it('rejects approve for a cancelled invoice with a 400 and never posts GL', async () => {
    sqlMock
      .mockResolvedValueOnce([]) // guarded UPDATE matches no row (status not approvable)
      .mockResolvedValueOnce([{ status: 'cancelled' }]); // existence/status probe

    const result = await call({ id: INV_ID, action: 'approve' });

    expect(result.kind).toBe('badRequest');
    expect(result.error).toMatch(/cannot approve/i);
    expect(result.error).toMatch(/cancelled/);
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('returns 404 when approving a non-existent invoice', async () => {
    sqlMock
      .mockResolvedValueOnce([]) // UPDATE matches nothing
      .mockResolvedValueOnce([]); // probe: invoice does not exist

    const result = await call({ id: INV_ID, action: 'approve' });
    expect(result.kind).toBe('notFound');
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('approves a draft invoice and posts GL', async () => {
    sqlMock.mockResolvedValueOnce([{ id: INV_ID }]); // guarded UPDATE matched a draft row
    postGlMock.mockResolvedValueOnce('je-123');
    snapshotMock.mockResolvedValueOnce({ documentId: 'doc-1', wasExisting: false });

    const result = await call({ id: INV_ID, action: 'approve' });

    expect(result.kind).toBe('success');
    expect(postGlMock).toHaveBeenCalledWith(COMPANY_ID, INV_ID, USER_ID);
  });

  it('maps a closed-period reversal error on cancel to a 400, not a 500', async () => {
    cancelMock.mockRejectedValueOnce(new ClosedFiscalPeriodError('closed'));

    const result = await call({ id: INV_ID, action: 'cancel' });

    expect(result.kind).toBe('badRequest');
    expect(result.error).toMatch(/closed fiscal period/i);
  });
});
