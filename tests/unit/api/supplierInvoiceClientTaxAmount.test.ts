/**
 * POST /api/accounting/supplier-invoices must not let a client set the VAT.
 *
 * `createSupplierInvoice` honours an exact per-line `taxAmount` so a migration
 * can carry the source system's authoritative tax. This route destructured
 * `items` from `req.body` and forwarded the objects verbatim, which would have
 * made that field client-settable: any write-access user could post
 * `unitPrice 100, taxRate 15, taxAmount 10000` and overstate input VAT without
 * bound, where tax had always been derived before.
 *
 * Two independent guards, one test each: the route whitelists the line fields,
 * and the service honours `taxAmount` only when the input itself carries
 * `trustSourceTax`, which no route copies from a body.
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
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({
  reserveNextDocumentNumber: vi.fn(async () => 'SIV-1'),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  getSupplierInvoices: vi.fn(),
  getSupplierInvoiceStatusCounts: vi.fn(),
  createSupplierInvoice: vi.fn(async () => ({ id: 'inv-1' })),
}));

import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import handler from '../../../pages/api/accounting/supplier-invoices';

const mockCreate = createSupplierInvoice as unknown as ReturnType<typeof vi.fn>;

function makeRes() {
  const res = { statusCode: 200 } as unknown as NextApiResponse & { body?: unknown };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = vi.fn((b: unknown) => { (res as { body?: unknown }).body = b; return res; }) as never;
  return res;
}

const post = (items: unknown[]) => ({
  method: 'POST',
  user: { id: 'u1' },
  companyId: 'c1',
  body: { supplierId: 's1', invoiceDate: '2026-03-01', taxRate: 15, items },
} as unknown as NextApiRequest);

describe('supplier-invoices POST does not accept a client-supplied line tax', () => {
  beforeEach(() => vi.clearAllMocks());

  it('strips taxAmount from every line before the service sees it', async () => {
    await handler(post([
      { description: 'a', quantity: 1, unitPrice: 100, taxRate: 15, taxAmount: 10000 },
      { description: 'b', quantity: 2, unitPrice: 50, taxRate: 15, taxAmount: 9999 },
    ]) as never, makeRes() as never);

    expect(mockCreate).toHaveBeenCalledOnce();
    const input = mockCreate.mock.calls[0]![1] as { items: Record<string, unknown>[] };
    for (const item of input.items) {
      expect(item).not.toHaveProperty('taxAmount', 10000);
      expect(item.taxAmount).toBeUndefined();
    }
  });

  it('never sets the importer opt-in from a request body', async () => {
    await handler(post([
      { description: 'a', quantity: 1, unitPrice: 100, taxRate: 15 },
    ]) as never, makeRes() as never);

    const input = mockCreate.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.trustSourceTax).toBeUndefined();
  });

  it('keeps every line field the service actually reads', async () => {
    await handler(post([{
      poItemId: 'po-1', description: 'a', quantity: 3, unitPrice: 25, taxRate: 0,
      vatClassification: 'exempt', glAccountId: 'gl-1', projectId: 'p-1', costCenterId: 'cc-1',
    }]) as never, makeRes() as never);

    const input = mockCreate.mock.calls[0]![1] as { items: Record<string, unknown>[] };
    expect(input.items[0]).toEqual({
      poItemId: 'po-1', description: 'a', quantity: 3, unitPrice: 25, taxRate: 0,
      vatClassification: 'exempt', glAccountId: 'gl-1', projectId: 'p-1', costCenterId: 'cc-1',
    });
  });
});
