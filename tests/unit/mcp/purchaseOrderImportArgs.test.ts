import { describe, expect, it } from 'vitest';
import {
  MAX_PURCHASE_ORDERS, parsePurchaseOrder, parsePurchaseOrderBatch, type ParsedPo,
} from '@/lib/mcp/tools/purchaseOrderImportArgs';

const SUP = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';

const po = (over: Record<string, unknown> = {}) => ({
  po_number: 'PO0000197', supplier_id: SUP, order_date: '2026-06-10',
  lines: [{ description: 'Cable', quantity: 2, unit_price: 100, gl_account_id: ACC }],
  ...over,
});
const parsed = (o: unknown) => {
  const r = parsePurchaseOrder(o, 0);
  if (typeof r === 'string') throw new Error(r);
  return r as ParsedPo;
};

describe('parsePurchaseOrder', () => {
  it('keeps the number as sent and prices the lines (VAT 15% by default)', () => {
    expect(parsed(po())).toMatchObject({
      poNumber: 'PO0000197', supplierId: SUP, status: 'draft', ref: null,
      totals: { subtotal: 20000, tax: 3000, total: 23000 },
      lines: [{ glAccountId: ACC, unitPrice: 100, taxRate: 15, cents: { net: 20000, tax: 3000 } }],
    });
  });

  it.each([
    ['open', 'approved'], ['approved', 'approved'], ['billed', 'closed'], ['closed', 'closed'], ['cancelled', 'cancelled'],
    ['Draft', 'draft'], [' OPEN ', 'approved'],
  ])('status %s is stored as %s', (sent, stored) => {
    expect(parsed(po({ status: sent })).status).toBe(stored);
  });

  it.each(['received', 'partially_received', 'submitted', 'invoiced', 42])('status %s is refused', (status) => {
    expect(parsePurchaseOrder(po({ status }), 0)).toMatch(/^purchase_orders\[0\]\.status must be one of draft, open, approved, closed, billed, cancelled/);
  });

  it('takes external_ref flat, as an object, or as a numeric Sage id', () => {
    const flat = parsed(po({ external_system: 'Sage', external_ref: '123', external_document_number: 'PO0000197' }));
    expect(flat.ref).toEqual({ system: 'sage', ref: '123', documentNumber: 'PO0000197' });
    expect(parsed(po({ external_ref: { system: 'sage', id: 123 } })).ref).toEqual({ system: 'sage', ref: '123', documentNumber: null });
    expect(parsed(po({ external_system: 'sage', external_ref: 123 })).ref).toMatchObject({ ref: '123' });
    expect(parsePurchaseOrder(po({ external_ref: '123' }), 0)).toMatch(/external_system is required/);
  });

  it('refuses expected_totals that differ from the lines, naming the PO', () => {
    expect(parsePurchaseOrder(po({ expected_totals: { subtotal: 200, tax_amount: 30, total: 230.01 } }), 0))
      .toBe('purchase_orders[0] (PO0000197): expected_totals.total is 230.01 but the lines add up to 230.00');
    expect(parsed(po({ expected_totals: { subtotal: 200, tax_amount: 30, total: 230 } })).totals.total).toBe(23000);
  });

  it.each([
    [{ po_number: '' }, /po_number is required/],
    [{ po_number: 'x'.repeat(51) }, /po_number is longer than 50/],
    [{ supplier_id: 'acme' }, /supplier_id must be a supplier UUID/],
    [{ order_date: '2026-02-30' }, /order_date must be a real date/],
    [{ delivery_date: '10/06/2026' }, /delivery_date must be a real date/],
    [{ inclusive: 'yes' }, /inclusive must be true or false/],
    [{ lines: [] }, /lines must be a non-empty array/],
    [{ lines: [{ description: 'a', quantity: 0, unit_price: 1 }] }, /lines\[0\]\.quantity must be more than 0/],
    [{ lines: [{ description: 'a', quantity: 1, unit_price: -1 }] }, /unit_price must be at least 0/],
    [{ lines: [{ description: 'a', quantity: 1, unit_price: 1, tax_rate: 101 }] }, /tax_rate must be at most 100/],
    [{ lines: [{ description: 'a', quantity: 1, unit_price: 1, line_total: 1.005 }] }, /line_total must be whole cents/],
    [{ lines: [{ description: 'a', quantity: 1, unit_price: 1, gl_account_id: 'x' }] }, /gl_account_id must be a UUID/],
    [{ lines: [{ description: 'a', quantity: 1, unit_price: 1, item_id: ACC }] }, /lines\[0\]\.item_id is not a field of this tool/],
    [{ total: 5 }, /purchase_orders\[0\]\.total is not a field of this tool/],
    [{ expected_totals: { vat: 1 } }, /expected_totals\.vat is not a field of this tool/],
    [{ lines: [{ description: 'a', quantity: 0.004, unit_price: 1 }] }, /quantity has at most two decimals/],
    [{ lines: [{ description: 'a', quantity: 1.005, unit_price: 1 }] }, /quantity has at most two decimals/],
    [{ lines: [{ description: 'a', quantity: 1e9, unit_price: 9999999999999 }] }, /line amount is more than the largest amount/],
    [{ lines: [{ description: 'a', quantity: 10, unit_price: 100, line_total: 1150 }] }, /line_total 1150\.00 is more than quantity x unit_price/],
    [{ lines: [{ description: 'a', quantity: 3_000_000, unit_price: 0.0000001, line_total: 0.3 }] }, /no unit price of 6 decimals gives line_total at this quantity/],
    [{ lines: [{ description: 'a', quantity: 1, unit_price: 1, tax_amount: 0.15 }] }, /tax_amount needs line_total/],
    [{ description: 'x'.repeat(501) }, /description is not a field/],
    [{ reference: 'x'.repeat(256) }, /reference is longer than 255/],
    [{ notes: 'x'.repeat(2001) }, /notes is longer than 2000/],
    [{ lines: Array.from({ length: 201 }, () => ({ description: 'a', quantity: 1, unit_price: 1 })) }, /lines has 201 lines; the maximum is 200/],
    [{ lines: [{ description: '', quantity: 1, unit_price: 1 }] }, /description is required/],
  ])('refuses %o', (over, message) => {
    expect(parsePurchaseOrder(po(over), 0)).toMatch(message);
  });
});

describe('the stored unit price', () => {
  it('is the effective ex-VAT price: a discount, a 4-decimal price, a delivery date kept', () => {
    const p = parsed(po({ delivery_date: '2026-07-01', lines: [
      { description: 'discounted', quantity: 10, unit_price: 100, line_total: 900 },
      { description: '4 decimals', quantity: 1000, unit_price: 1.2345 },
      { description: 'thirds', quantity: 3, unit_price: 40, line_total: 100 },
    ] }));
    expect(p.deliveryDate).toBe('2026-07-01');
    expect(p.lines.map((l) => [l.unitPrice, l.cents.net])).toEqual([[90, 90000], [1.2345, 123450], [33.333333, 10000]]);
  });

  it('refuses a PO whose total no document can hold', () => {
    const lines = Array.from({ length: 2 }, () => ({ description: 'big', quantity: 1, unit_price: 6e12, tax_rate: 0 }));
    expect(parsePurchaseOrder(po({ lines }), 0)).toMatch(/the PO total is more than the largest amount/);
  });
});

describe('parsePurchaseOrderBatch', () => {
  it('refuses an empty or oversized batch', () => {
    expect(parsePurchaseOrderBatch([])).toBe('purchase_orders must be a non-empty array');
    expect(parsePurchaseOrderBatch(undefined)).toBe('purchase_orders must be a non-empty array');
    const many = Array.from({ length: MAX_PURCHASE_ORDERS + 1 }, (_, i) => po({ po_number: `PO${i}` }));
    expect(parsePurchaseOrderBatch(many)).toMatch(/has 101 elements; the maximum is 100/);
  });

  it('refuses a number or an external reference named twice', () => {
    expect(parsePurchaseOrderBatch([po(), po()])).toBe('purchase_orders[1]: po_number PO0000197 is also purchase_orders[0]; each PO may appear once');
    const a = po({ external_system: 'sage', external_ref: '9' });
    const b = po({ po_number: 'PO0000198', external_system: 'SAGE', external_ref: '9' });
    expect(parsePurchaseOrderBatch([a, b])).toBe('purchase_orders[1]: external_ref 9 is also purchase_orders[0]; each PO may appear once');
  });

  it('keeps each element\'s index', () => {
    const r = parsePurchaseOrderBatch([po(), po({ po_number: 'PO0000198' })]) as ParsedPo[];
    expect(r.map((p) => [p.index, p.poNumber])).toEqual([[0, 'PO0000197'], [1, 'PO0000198']]);
  });
});
