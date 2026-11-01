/**
 * invoice-pdf `disposition`: the preview asks for inline, everything else keeps
 * the attachment it always had, and an unknown value is refused before any PDF
 * is rendered. And the render limit: each member's own bucket, charged only for
 * a request that would render.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { generateInvoicePdf, getInvoicePdfFilename, checkReportRateLimit } = vi.hoisted(() => ({
  generateInvoicePdf: vi.fn(),
  getInvoicePdfFilename: vi.fn(),
  checkReportRateLimit: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/invoicePdfService', () => ({ generateInvoicePdf, getInvoicePdfFilename }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit, INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import handler from '../../../pages/api/accounting/invoice-pdf';

const invoiceId = '10000000-0000-4000-8000-000000000001';

function call(query: Record<string, unknown>) {
  const headers: Record<string, unknown> = {};
  const state: { status: number; body: unknown } = { status: 0, body: undefined };
  const res = {
    setHeader: (k: string, v: unknown) => { headers[k] = v; return res; },
    status: (c: number) => { state.status = c; return res; },
    json: (b: unknown) => { state.body = b; return res; },
    end: (b: unknown) => { state.body = b; return res; },
  } as unknown as NextApiResponse;
  const req = { method: 'GET', companyId: 'c-1', user: { id: 'u-1' }, query: { invoiceId, ...query } } as unknown as NextApiRequest;
  return Promise.resolve((handler as unknown as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res))
    .then(() => ({ ...state, headers }));
}

beforeEach(() => {
  vi.clearAllMocks();
  generateInvoicePdf.mockResolvedValue(Buffer.from('%PDF-1.3'));
  getInvoicePdfFilename.mockResolvedValue('Invoice-INV1.pdf');
  checkReportRateLimit.mockResolvedValue(true);
});

describe('invoice-pdf disposition', () => {
  it('defaults to attachment', async () => {
    const out = await call({});
    expect(out.status).toBe(200);
    expect(out.headers['Content-Disposition']).toBe('attachment; filename="Invoice-INV1.pdf"');
  });

  it('serves inline when asked', async () => {
    const out = await call({ disposition: 'inline' });
    expect(out.status).toBe(200);
    expect(out.headers['Content-Disposition']).toBe('inline; filename="Invoice-INV1.pdf"');
    expect(out.headers['Content-Type']).toBe('application/pdf');
  });

  it('accepts attachment by name', async () => {
    const out = await call({ disposition: 'attachment' });
    expect(out.headers['Content-Disposition']).toBe('attachment; filename="Invoice-INV1.pdf"');
  });

  it.each([['form-data'], ['INLINE'], [''], [['inline', 'attachment']], ['inline; filename="x"']])(
    'refuses %j before rendering anything', async (disposition) => {
      const out = await call({ disposition });
      expect(out.status).toBe(400);
      expect(generateInvoicePdf).not.toHaveBeenCalled();
      expect(out.headers['Content-Disposition']).toBeUndefined();
      expect(checkReportRateLimit).not.toHaveBeenCalled();
    });
});

describe('invoice-pdf render limit', () => {
  it('charges the member, not the company, at the interactive limit', async () => {
    await call({});
    expect(checkReportRateLimit).toHaveBeenCalledTimes(1);
    expect(checkReportRateLimit).toHaveBeenCalledWith('c-1', 'invoice-pdf:u:u-1', { max: 120, windowSecs: 900 });
  });

  it('answers 429 over the limit without rendering or naming a file', async () => {
    checkReportRateLimit.mockResolvedValue(false);
    const out = await call({ disposition: 'inline' });
    expect(out.status).toBe(429);
    expect(generateInvoicePdf).not.toHaveBeenCalled();
    expect(getInvoicePdfFilename).not.toHaveBeenCalled();
    expect(out.headers['Content-Type']).toBeUndefined();
  });
});
