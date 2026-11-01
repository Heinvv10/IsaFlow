/** getSupplierInvoiceById reads the lines through the one shared ORDER BY (the order migration 708 hashes them in). */
import { describe, it, expect, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: Object.assign(sqlMock, { unsafe: (text: string) => text }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '@/modules/accounting/services/ap/supplierInvoiceLineOrder';

describe('getSupplierInvoiceById', () => {
  it('orders the lines with SUPPLIER_INVOICE_LINE_ORDER_BY, on the sii alias', async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{ id: 'inv', company_id: 'co', supplier_id: 's', status: 'draft' }]).mockResolvedValueOnce([]);
    await getSupplierInvoiceById('co', 'inv');
    const [strings, ...values] = sqlMock.mock.calls[1] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/FROM supplier_invoice_items sii/);
    expect(values).toContain(SUPPLIER_INVOICE_LINE_ORDER_BY);
  });
});
