/**
 * One parser for a line's item_id across the bill, invoice and quote tools (itemToolArgs.itemIdArg): absent -> not sent,
 * null -> clear, a UUID -> lower-cased, anything else -> a refusal naming the line.
 */
import { describe, expect, it } from 'vitest';
import { itemIdArg } from '@/lib/mcp/tools/itemToolArgs';
import { parseSupplierLines } from '@/lib/mcp/tools/invoiceCreateArgs';
import { parseCustomerInvoiceInput } from '@/lib/mcp/tools/customerInvoiceCreateArgs';

const U = 'ABCDEFAB-1111-4111-8111-ABCDEFABCDEF';
const LOWER = U.toLowerCase();
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

describe('itemIdArg', () => {
  it('absent, null, uuid (lower-cased) and the refusal', () => {
    expect(itemIdArg(undefined, 'items[0]')).toEqual({});
    expect(itemIdArg(null, 'items[0]')).toEqual({ itemId: null });
    expect(itemIdArg(U, 'items[0]')).toEqual({ itemId: LOWER });
    for (const bad of ['nope', 5, {}, ['x'], '']) expect(itemIdArg(bad, 'items[2]'), String(bad)).toBe('items[2].item_id must be a UUID');
  });
});

describe('the three line parsers share it', () => {
  it('bill lines (create_supplier_invoice / update_supplier_invoice)', () => {
    const ok = parseSupplierLines([{ description: 'a', quantity: 1, unit_price: 1, item_id: U }, { description: 'b', quantity: 1, unit_price: 1, item_id: null }, { description: 'c', quantity: 1, unit_price: 1 }]);
    expect(typeof ok).not.toBe('string');
    const items = (ok as { items: Array<{ itemId?: string | null }> }).items;
    expect(items.map((i) => i.itemId)).toEqual([LOWER, null, undefined]);
    expect(parseSupplierLines([{ description: 'a', quantity: 1, unit_price: 1, item_id: 'zz' }])).toBe('lines[0].item_id must be a UUID');
  });

  it('customer invoice lines (create_draft_invoice / bulk_create_customer_invoices)', () => {
    const ok = parseCustomerInvoiceInput({ customer_id: CUSTOMER, items: [{ description: 'a', unit_price: 1, item_id: U }, { description: 'b', unit_price: 1, item_id: null }] });
    expect(typeof ok).not.toBe('string');
    expect((ok as { items: Array<{ itemId?: string | null }> }).items.map((i) => i.itemId)).toEqual([LOWER, null]);
    expect(parseCustomerInvoiceInput({ customer_id: CUSTOMER, items: [{ description: 'a', unit_price: 1, item_id: 7 }] })).toBe('items[0].item_id must be a UUID');
  });
});
