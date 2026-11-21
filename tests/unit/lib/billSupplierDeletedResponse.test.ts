/**
 * 1021's supplier-live trigger refuses a bill written onto a soft-deleted supplier with SQLSTATE 23503 and constraint
 * supplier_invoices_supplier_live (review of b4741393, M2). Writers that do not map it themselves (capture post, the AI pipeline,
 * any route that rethrows) reach respondToUnhandledError: it answers a typed 409 with the refusal's wording, not a 500 with the
 * driver's text. The typed error itself answers the same.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { respondToUnhandledError, withErrorHandler } from '@/lib/api-error-handler';
import { BillSupplierDeletedError } from '@/modules/accounting/services/ap/billSupplierLive';

const TRIGGER_ERROR = Object.assign(new Error('supplier 1 has been merged or deleted; a bill cannot be written onto it'), {
  code: '23503', constraint: 'supplier_invoices_supplier_live',
});
const OTHER_FK = Object.assign(new Error('insert or update violates foreign key constraint'), { code: '23503', constraint: 'supplier_invoices_supplier_id_fkey' });

const fakeRes = () => {
  const res = {
    statusCode: 0, headers: {} as Record<string, string>, body: undefined as unknown, headersSent: false, writableEnded: false,
    setHeader: vi.fn((k: string, v: string) => { res.headers[k] = v; }),
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
    end: vi.fn(),
  };
  return res;
};

describe('a bill onto a soft-deleted supplier, unmapped by its route', () => {
  it.each([['the trigger\'s raw 23503', TRIGGER_ERROR], ['the typed error', new BillSupplierDeletedError()]])('%s answers 409 with the typed wording', (_, err) => {
    const res = fakeRes();
    respondToUnhandledError(res as unknown as NextApiResponse, err);
    expect(res.statusCode).toBe(409);
    const body = JSON.stringify(res.body);
    expect(body).toContain('SUPPLIER_INVOICE_SUPPLIER_DELETED');
    expect(body).toContain('has been merged into another or deleted');
    expect(body).not.toContain('supplier 1 has been merged');
  });

  it('another foreign-key violation is still a 500', () => {
    const res = fakeRes();
    respondToUnhandledError(res as unknown as NextApiResponse, OTHER_FK);
    expect(res.statusCode).toBe(500);
  });

  it('a route that rethrows it answers 409 through withErrorHandler', async () => {
    const res = fakeRes();
    const handler = withErrorHandler(async () => { throw TRIGGER_ERROR; });
    await handler({ method: 'POST', url: '/api/accounting/capture/x/post', headers: {}, query: {}, body: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(409);
  });
});
