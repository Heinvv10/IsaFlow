/**
 * Unit tests for the /api/accounting/supplier-invoices-bulk-action handler.
 *
 * Verifies:
 *  - Zod schema rejects bad shapes (400)
 *  - per-id error isolation (one failure doesn't poison the rest)
 *  - per-id results are reported with succeeded/failed counts
 *  - method guard returns 405 for non-POST
 *  - the per-id SAVEPOINT nests correctly inside a service's own savepoint
 *  - a FAILED savepoint rollback is reported as a thrown error, never as success
 *
 * `@/lib/neon` is deliberately NOT mocked: the last two need the real
 * `withSavepoint`, driven against a stub pg client inside a real `als.run`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { PoolClient } from 'pg';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));

vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (fn: unknown) => fn,
}));

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (fn: unknown) => fn,
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ success: true, data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ success: false, error })),
    methodNotAllowed: vi.fn((_res: unknown, _method: string) => ({ success: false, error: 'method not allowed' })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ success: false, errors })),
    internalError: vi.fn(),
  },
}));

// vi.hoisted runs before vi.mock factories. Without it, mocks would close over
// the still-undefined const bindings declared further down.
const { approveMock, cancelMock, postGlMock } = vi.hoisted(() => ({
  approveMock: vi.fn(),
  cancelMock: vi.fn(),
  postGlMock: vi.fn(),
}));

vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  approveSupplierInvoice: approveMock,
  cancelSupplierInvoice: cancelMock,
}));

vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({
  postSupplierInvoiceToGL: postGlMock,
}));

import handler from '../../../pages/api/accounting/supplier-invoices-bulk-action';
import { als } from '@/lib/als';
import { withSavepoint } from '@/lib/neon';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
// v4 UUIDs (the version nibble must be `4` for Zod's `.uuid()` to accept).
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

function req(method: string, body: unknown): NextApiRequest {
  return {
    method,
    body,
    companyId: COMPANY_ID,
    user: { id: USER_ID },
  } as unknown as NextApiRequest;
}

function res(): NextApiResponse {
  return {} as NextApiResponse;
}

describe('supplier-invoices-bulk-action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approveMock.mockReset();
    cancelMock.mockReset();
    postGlMock.mockReset();
  });

  it('returns 405 for non-POST requests', async () => {
    const result = await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(req('GET', {}), res());
    expect(result).toEqual({ success: false, error: 'method not allowed' });
  });

  it('rejects an empty invoiceIds array via validation error', async () => {
    const result = await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'approve', invoiceIds: [] }),
      res(),
    );
    expect((result as { success: boolean }).success).toBe(false);
  });

  it('rejects invoiceIds longer than 200 via validation error', async () => {
    const ids = Array.from({ length: 201 }, () => ID_A);
    const result = await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'approve', invoiceIds: ids }),
      res(),
    );
    expect((result as { success: boolean }).success).toBe(false);
  });

  it('rejects an unknown action via validation error', async () => {
    const result = await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'demolish', invoiceIds: [ID_A] }),
      res(),
    );
    expect((result as { success: boolean }).success).toBe(false);
  });

  it('rejects non-UUID ids via validation error', async () => {
    const result = await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'approve', invoiceIds: ['not-a-uuid'] }),
      res(),
    );
    expect((result as { success: boolean }).success).toBe(false);
  });

  it('approves all 3 ids when each call succeeds', async () => {
    approveMock.mockResolvedValue({});
    const result = await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'approve', invoiceIds: [ID_A, ID_B, ID_C] }),
      res(),
    );
    expect(approveMock).toHaveBeenCalledTimes(3);
    expect(approveMock).toHaveBeenNthCalledWith(1, COMPANY_ID, ID_A, USER_ID);
    expect((result as { data: { succeeded: number; failed: number } }).data).toEqual(
      expect.objectContaining({ action: 'approve', total: 3, succeeded: 3, failed: 0 }),
    );
  });

  it('isolates a single id failure — succeeded ids still complete', async () => {
    approveMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('row already approved'))
      .mockResolvedValueOnce({});
    const result = await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'approve', invoiceIds: [ID_A, ID_B, ID_C] }),
      res(),
    );
    expect(approveMock).toHaveBeenCalledTimes(3);
    const data = (result as { data: { succeeded: number; failed: number; results: Array<{ invoiceId: string; ok: boolean; error?: string }> } }).data;
    expect(data.succeeded).toBe(2);
    expect(data.failed).toBe(1);
    expect(data.results[1]).toEqual({ invoiceId: ID_B, ok: false, error: 'row already approved' });
    expect(data.results[0]?.ok).toBe(true);
    expect(data.results[2]?.ok).toBe(true);
  });

  it('routes action=cancel to cancelSupplierInvoice', async () => {
    cancelMock.mockResolvedValue({});
    await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'cancel', invoiceIds: [ID_A] }),
      res(),
    );
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith(COMPANY_ID, ID_A, USER_ID);
    expect(approveMock).not.toHaveBeenCalled();
    expect(postGlMock).not.toHaveBeenCalled();
  });

  // The route's per-id savepoint is the guarantee that one bad row cannot take
  // the batch, so it must survive a service that opens a savepoint of its own —
  // which cancelSupplierInvoice does. Nested SAVEPOINTs must be established and
  // released strictly LIFO, and the outer name must never coexist with itself
  // across two iterations.
  it('nests the per-id savepoint around a service savepoint in LIFO order', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    cancelMock.mockImplementation(() =>
      withSavepoint('cancel_supplier_invoice', async () => ({})),
    );

    const result = await als.run(
      { client, userId: USER_ID, companyId: COMPANY_ID, claims: {} },
      () => (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
        req('POST', { action: 'cancel', invoiceIds: [ID_A, ID_B] }),
        res(),
      ),
    );

    expect((result as { data: { succeeded: number } }).data.succeeded).toBe(2);
    expect(statements.filter((t) => t.includes('SAVEPOINT'))).toEqual([
      'SAVEPOINT bulk_supplier_invoice_item',
      'SAVEPOINT cancel_supplier_invoice',
      'RELEASE SAVEPOINT cancel_supplier_invoice',
      'RELEASE SAVEPOINT bulk_supplier_invoice_item',
      'SAVEPOINT bulk_supplier_invoice_item',
      'SAVEPOINT cancel_supplier_invoice',
      'RELEASE SAVEPOINT cancel_supplier_invoice',
      'RELEASE SAVEPOINT bulk_supplier_invoice_item',
    ]);
  });

  // The one path where a regression reinstates the defect this route exists to
  // prevent: when ROLLBACK TO SAVEPOINT itself fails the connection is aborted,
  // nothing this request wrote can commit, and withAuth's COMMIT on a <500
  // response is executed as ROLLBACK without raising. Reporting the earlier id
  // as succeeded would be a lie the caller cannot detect, so the handler must
  // THROW and let withErrorHandler answer 5xx.
  it('throws instead of reporting success when a savepoint rollback fails', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.startsWith('ROLLBACK TO SAVEPOINT')) {
          throw new Error('connection aborted');
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    approveMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('lock timeout'));

    const store = { client, userId: USER_ID, companyId: COMPANY_ID, claims: {} };
    await expect(
      als.run(store, () => (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
        req('POST', { action: 'approve', invoiceIds: [ID_A, ID_B] }),
        res(),
      )),
    ).rejects.toThrow(/transaction became unusable/);
    // And the reason is recorded, not invented by the route.
    expect(store).toHaveProperty('txUnusable');
  });

  it('routes action=post_gl to postSupplierInvoiceToGL with userId', async () => {
    postGlMock.mockResolvedValue({});
    await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      req('POST', { action: 'post_gl', invoiceIds: [ID_A] }),
      res(),
    );
    expect(postGlMock).toHaveBeenCalledTimes(1);
    expect(postGlMock).toHaveBeenCalledWith(COMPANY_ID, ID_A, USER_ID);
  });
});
