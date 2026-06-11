/**
 * PR #158 review refinements to the VAT exceptions report:
 *  - degraded-data flag when generateVAT201 ran on missing sources
 *  - invoices linked to a non-posted (draft) JE labeled 'je_not_posted'
 *    instead of listing as an amount mismatch with GL 0.00
 *  - unposted-VAT footnote aggregates input VAT from supplier_invoice_items
 *    when present (same source as field10)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const generateVAT201 = vi.fn();
vi.mock('@/modules/accounting/services/reports/vat201Service', () => ({
  generateVAT201: (...a: unknown[]) => generateVAT201(...a),
}));

import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';

const HEALTHY_VAT201 = {
  periodStart: '2026-01-01', periodEnd: '2026-02-28',
  field1_standardRatedSupplies: 0, field2_zeroRatedSupplies: 0, field3_exemptSupplies: 0,
  field4_totalImports: 0, field5_outputVAT: 0, field6_capitalGoods: 0, field7_otherGoods: 0,
  field8_services: 0, field9_imports: 0, field10_totalInputVAT: 0,
  field11_vatPayableOrRefundable: 0, outputInvoices: [], inputInvoices: [],
  degradedSources: [] as string[],
};

function queryText(call: unknown[]): string {
  return (call[0] as readonly string[]).join('?');
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(async () => []);
  generateVAT201.mockResolvedValue(HEALTHY_VAT201);
});

describe('getVatExceptions degraded-data flag', () => {
  it('is clean when VAT201 sources are healthy', async () => {
    const report = await getVatExceptions('co-1', '2026-01-01', '2026-02-28');
    expect(report.degradedData).toBe(false);
    expect(report.degradedSources).toEqual([]);
  });

  it('surfaces degraded sources from generateVAT201', async () => {
    generateVAT201.mockResolvedValue({ ...HEALTHY_VAT201, degradedSources: ['customer_invoices'] });
    const report = await getVatExceptions('co-1', '2026-01-01', '2026-02-28');
    expect(report.degradedData).toBe(true);
    expect(report.degradedSources).toEqual(['customer_invoices']);
  });
});

describe('getVatExceptions draft-JE mismatches', () => {
  it("labels a mismatch whose JE is not posted as 'je_not_posted'", async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('FROM customer_invoices ci') && q.includes('invoice_vat')) {
        return [{
          invoice_id: 'ci-1', invoice_number: 'INV-1', invoice_date: '2026-01-15',
          counterparty_name: 'Acme', invoice_vat: 150, gl_vat: 0,
          je_status: 'draft', total_count: 1,
        }];
      }
      return [];
    });
    const report = await getVatExceptions('co-1', '2026-01-01', '2026-02-28');
    expect(report.invoiceGlMismatches).toHaveLength(1);
    expect(report.invoiceGlMismatches[0]).toMatchObject({ invoiceId: 'ci-1', reason: 'je_not_posted' });
  });

  it("labels a posted-JE variance as 'amount_mismatch'", async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('FROM supplier_invoices si') && q.includes('invoice_vat')) {
        return [{
          invoice_id: 'si-1', invoice_number: 'SUP-1', invoice_date: '2026-01-20',
          counterparty_name: 'Vendor', invoice_vat: 150, gl_vat: 149.85,
          je_status: 'posted', total_count: 1,
        }];
      }
      return [];
    });
    const report = await getVatExceptions('co-1', '2026-01-01', '2026-02-28');
    expect(report.invoiceGlMismatches[0]).toMatchObject({ invoiceId: 'si-1', reason: 'amount_mismatch' });
  });
});

describe('getVatExceptions unposted-VAT footnote', () => {
  it('aggregates the supplier side from supplier_invoice_items (field10 source parity)', async () => {
    await getVatExceptions('co-1', '2026-01-01', '2026-02-28');
    const unpostedCall = sqlMock.mock.calls.find((c) => queryText(c).includes('unposted_supplier_vat'));
    expect(unpostedCall).toBeDefined();
    expect(queryText(unpostedCall!)).toContain('supplier_invoice_items');
  });
});
