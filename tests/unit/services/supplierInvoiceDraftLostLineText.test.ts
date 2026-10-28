/**
 * The refusal for a stored line the replacement lines would drop names the line by its amount, not its description:
 * the message reaches error capture, and a description is customer text.
 */
import { describe, it, expect, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: Object.assign(sqlMock, { unsafe: (text: string) => text }) }));
vi.mock('@/modules/accounting/services/ap/billLineAccountGuard', () => ({ billLineAccountRefusal: vi.fn().mockResolvedValue(null) }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionDerivation', () => ({ deriveLineDimensions: vi.fn(async (_c: string, items: unknown) => items) }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionPolicy', () => ({ assertDocumentDimensions: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionKeepStored', () => ({ keepStoredDimensions: vi.fn((items: unknown) => items) }));

import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '@/modules/accounting/services/ap/supplierInvoiceLineOrder';
import { planLines, SupplierInvoiceDraftUpdateRefusal } from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdateGuards';

describe('planLines: a stored line the replacement would drop', () => {
  const stored = (over: object) => ({
    description: 'Cash to J SMITH 0123456789', quantity: '1.0000', unit_price: '250.00', tax_rate: '15.00', tax_amount: '37.50',
    line_total: '250.00', gl_account_id: null, po_item_id: null, project_id: null, cost_center_id: null,
    vat_classification: null, cc1_id: null, cc2_id: null, bu_id: null, ...over,
  });

  it('reads the stored lines through the one shared ORDER BY (the order the invoice shows them in)', async () => {
    sqlMock.mockClear();
    sqlMock.mockResolvedValue([stored({})]);
    await planLines('co', 'inv', 'INV-9', [{ description: 'x', quantity: 1, unitPrice: 250, taxRate: 15 }] as never, 15).catch(() => null);
    const [strings, ...values] = sqlMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/FROM supplier_invoice_items sii/);
    expect(values).toContain(SUPPLIER_INVOICE_LINE_ORDER_BY);
  });

  it('is named by its position and amount; its description is not in the message', async () => {
    sqlMock.mockResolvedValue([stored({ description: 'ok', line_total: '250.00' }), stored({ po_item_id: 'po-1' })]);
    const err = await planLines('co', 'inv', 'INV-9', [{ description: 'Something else', quantity: 2, unitPrice: 10, taxRate: 15 }] as never, 15)
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(SupplierInvoiceDraftUpdateRefusal);
    expect(err!.message).toMatch(/^Supplier invoice INV-9 has stored line 2 \(R250\.00\) that carries a purchase-order link, /);
    expect(err!.message).not.toMatch(/SMITH|0123456789/);
  });
});
