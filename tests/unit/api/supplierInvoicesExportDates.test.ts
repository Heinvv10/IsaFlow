/**
 * The supplier-invoice CSV is a machine output: its dates stay ISO (2026-10-21) and its amounts plain
 * numbers. A display date ("21 Oct 2026") or a "—" in a column someone re-imports into a spreadsheet
 * or another system silently breaks it.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceFilterParams', () => ({
  parseSupplierInvoiceFilters: () => ({ ok: true, filters: {} }),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  SUPPLIER_INVOICE_EXPORT_CAP: 1000,
  getSupplierInvoicesForExport: async () => ({
    truncated: false,
    invoices: [
      { invoiceNumber: 'S-1', supplierName: 'Acme', reference: null, invoiceDate: '2026-10-21', dueDate: new Date(2026, 10, 20, 0, 0),
        subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 0, balance: 1150, status: 'approved' },
      { invoiceNumber: 'S-2', supplierName: 'Beta', reference: 'r', invoiceDate: '2026-01-05T00:00:00Z', dueDate: null,
        subtotal: 25000, taxAmount: 0, totalAmount: 25000, amountPaid: 0, balance: 25000, status: 'draft' },
      { invoiceNumber: 'S-3', supplierName: 'Gamma', reference: null, invoiceDate: '2026-10-20 22:00:00+00', dueDate: '2026-10-20T21:59:59Z',
        subtotal: 1, taxAmount: 0, totalAmount: 1, amountPaid: 0, balance: 1, status: 'draft' },
    ],
  }),
}));

import handler from '@/../pages/api/accounting/supplier-invoices-export';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('supplier invoices CSV', () => {
  // The file must show the same day on any device: Johannesburg, Los Angeles (UTC-8), Kiritimati (UTC+14).
  it.each(['Africa/Johannesburg', 'America/Los_Angeles', 'Pacific/Kiritimati'])('writes ISO dates and plain numbers, never a display date (device in %s)', async (zone) => {
    process.env.TZ = zone;
    let body = '';
    const res = { setHeader: vi.fn(), status: () => res, send: (b: string) => { body = b; return res; } } as unknown as NextApiResponse;
    await (handler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(
      { method: 'GET', query: {}, companyId: 'c-1' } as unknown as NextApiRequest, res);
    const rows = body.split('\n');
    expect(rows[1]).toBe('"S-1","Acme","","2026-10-21","2026-11-20",1000.00,150.00,1150.00,0.00,1150.00,"approved"');
    expect(rows[2]).toContain('"2026-01-05",""');
    expect(rows[2]).toContain(',25000.00,');
    // 22:00Z is already the 21st in Johannesburg, 21:59:59Z is still the 20th
    expect(rows[3]).toBe('"S-3","Gamma","","2026-10-21","2026-10-20",1.00,0.00,1.00,0.00,1.00,"draft"');
    expect(body).not.toMatch(/\b[A-Z][a-z]{2} 20\d\d\b|—/);
  });
});
