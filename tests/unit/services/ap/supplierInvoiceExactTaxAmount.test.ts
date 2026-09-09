/**
 * `createSupplierInvoice` derives each line's tax from a rate, and the rate a
 * migration can supply is rounded to 2 dp. For a 700.00 / 33.33 Sage bill that
 * rate is 4.76%, which re-derives 33.32 and stores a 733.32 total against a
 * journal posted for Sage's 733.33 — one bill, two totals.
 *
 * `SupplierInvoiceItemInput.taxAmount` lets an importer pass the source's exact
 * figure instead. These tests read the values actually bound into the INSERT,
 * not a mocked row, so the arithmetic is what is under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const txCalls: unknown[][] = [];

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([{ vat_number: null }]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      const tx = vi.fn((...args: unknown[]) => {
        txCalls.push(args);
        return Promise.resolve([{ id: 'inv-1', subtotal: '0', tax_amount: '0', total_amount: '0' }]);
      });
      return cb(tx);
    }),
    fmtDate: (d: unknown) => String(d),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/capture/captureDeduplicationService', () => ({
  computeFingerprint: () => 'fp',
}));

const { createSupplierInvoice } = await import('@/modules/accounting/services/ap/supplierInvoiceService');
import type { SupplierInvoiceCreateInput } from '@/modules/accounting/types/ap.types';

/** The bound values of the first tx call — the supplier_invoices INSERT. */
function headerValues(): unknown[] {
  return txCalls[0]!.slice(1);
}

const input = (over: Partial<SupplierInvoiceCreateInput> = {}): SupplierInvoiceCreateInput => ({
  invoiceNumber: 'INV-1', supplierId: 'sup-1', invoiceDate: '2026-03-01',
  taxRate: 4.76,
  items: [{ description: 'line', quantity: 1, unitPrice: 700 }],
  ...over,
});

describe('createSupplierInvoice honours an exact line tax amount', () => {
  beforeEach(() => { txCalls.length = 0; vi.clearAllMocks(); });

  it('stores the supplied tax and total, not the figures the 2 dp rate derives', async () => {
    await createSupplierInvoice('c1', input({
      items: [{ description: 'line', quantity: 1, unitPrice: 700, taxAmount: 33.33 }],
    }), 'u1');

    const v = headerValues();
    expect(v).toContain(33.33);
    expect(v).toContain(733.33);
    // The rate-derived figures must NOT appear.
    expect(v).not.toContain(33.32);
    expect(v).not.toContain(733.32);
  });

  it('leaves every caller that supplies no tax amount on the rate as before', async () => {
    await createSupplierInvoice('c1', input(), 'u1');

    const v = headerValues();
    expect(v).toContain(33.32);
    expect(v).toContain(733.32);
  });

  it('still derives from the rate when the rate is exact', async () => {
    await createSupplierInvoice('c1', input({
      taxRate: 15, items: [{ description: 'line', quantity: 1, unitPrice: 1000 }],
    }), 'u1');

    const v = headerValues();
    expect(v).toContain(150);
    expect(v).toContain(1150);
  });

  it('rejects a negative tax amount rather than storing a credit as a bill', async () => {
    await expect(createSupplierInvoice('c1', input({
      items: [{ description: 'line', quantity: 1, unitPrice: 700, taxAmount: -1 }],
    }), 'u1')).rejects.toThrow(/tax amount must be a non-negative number/);
  });

  it('rejects a non-finite tax amount rather than writing NaN', async () => {
    await expect(createSupplierInvoice('c1', input({
      items: [{ description: 'line', quantity: 1, unitPrice: 700, taxAmount: Number.NaN }],
    }), 'u1')).rejects.toThrow(/tax amount must be a non-negative number/);
  });

  it('treats an explicit zero as zero tax, not as absent', async () => {
    await createSupplierInvoice('c1', input({
      items: [{ description: 'line', quantity: 1, unitPrice: 700, taxAmount: 0 }],
    }), 'u1');

    const v = headerValues();
    expect(v).toContain(0);
    expect(v).toContain(700);
    expect(v).not.toContain(33.32);
  });
});
