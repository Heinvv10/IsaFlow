/**
 * update_purchase_order and the cancel / close / set-status tools: the arguments, parsed with no I/O. Every refusal names the field;
 * nothing is read before it. The writes and every database rule run against real PostgreSQL in
 * tests/integration/mcp-po-maintenance*.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseUpdateArgs } from '@/lib/mcp/tools/purchaseOrderUpdateArgs';
import { parseMaintenanceArgs } from '@/lib/mcp/tools/purchaseOrderMaintenanceArgs';

const PO = '11111111-1111-4111-8111-111111111111';
const SUP = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const line = (o: Record<string, unknown> = {}) => ({ description: 'Cable', quantity: 2, unit_price: 10, ...o });

describe('parseUpdateArgs', () => {
  it('parses a header-only and a lines edit; omitted stays undefined, null clears', () => {
    expect(parseUpdateArgs({ po_id: PO.toUpperCase(), notes: null, reference: ' R1 ', delivery_date: null, order_date: '2026-06-20' })).toMatchObject({
      poId: PO, poNumber: null, lines: null, dryRun: false, inclusive: false,
      header: { notes: null, reference: 'R1', deliveryDate: null, orderDate: '2026-06-20' },
    });
    const p = parseUpdateArgs({ po_number: 'PO7', lines: [line({ item_code: ' CAB-1 ', cc2: 'ben' }), line({ item_id: ITEM.toUpperCase(), tax_rate: 0, line_total: 19.5, tax_amount: 0 })], dry_run: true });
    expect(p).toMatchObject({ poNumber: 'PO7', dryRun: true });
    const lines = (p as { lines: Array<Record<string, unknown>> }).lines;
    expect(lines[0]).toMatchObject({ itemCode: 'CAB-1', itemId: null, taxRate: undefined, dims: { cc2: 'ben' } });
    expect(lines[1]).toMatchObject({ itemId: ITEM, itemCode: null, taxRate: 0, lineTotal: 19.5, taxAmount: 0 });
  });

  it.each([
    [{}, 'give exactly one of po_id and po_number'],
    [{ po_id: PO, po_number: 'PO7' }, 'give exactly one of po_id and po_number'],
    [{ po_id: PO }, 'nothing to update: send a header field or lines'],
    [{ po_id: PO, colour: 'red' }, 'arguments.colour is not a field of this tool'],
    [{ po_id: PO, supplier_id: 'acme' }, 'supplier_id must be a supplier UUID'],
    [{ po_id: PO, supplier_id: null }, 'supplier_id must be a supplier UUID'],
    [{ po_id: PO, order_date: null }, 'order_date cannot be cleared'],
    [{ po_id: PO, order_date: '2026-02-31' }, 'must be a real date'],
    [{ po_id: PO, delivery_date: 'soon' }, 'must be a real date'],
    [{ po_id: PO, reference: 7 }, 'reference must be a string'],
    [{ po_id: PO, notes: 'n'.repeat(2001) }, 'notes is longer than 2000 characters'],
    [{ po_id: PO, dry_run: 'yes', notes: 'x' }, 'dry_run must be true or false'],
    [{ po_id: PO, lines: [] }, 'lines must be a non-empty array'],
    [{ po_id: PO, lines: [line(), 'x'] }, 'lines[1] must be an object'],
    [{ po_id: PO, lines: [line({ colour: 'red' })] }, 'lines[0].colour is not a field of this tool'],
    [{ po_id: PO, lines: [line({ quantity: 0 })] }, 'lines[0].quantity must be more than 0'],
    [{ po_id: PO, lines: [line({ quantity: 1.005 })] }, 'lines[0].quantity has at most two decimals'],
    [{ po_id: PO, lines: [line({ unit_price: -1 })] }, 'lines[0].unit_price must be at least 0'],
    [{ po_id: PO, lines: [line({ tax_rate: 101 })] }, 'lines[0].tax_rate must be at most 100'],
    [{ po_id: PO, lines: [line({ gl_account_id: 'x' })] }, 'lines[0].gl_account_id must be a UUID'],
    [{ po_id: PO, lines: [line({ item_id: 'x' })] }, 'lines[0].item_id must be an item UUID'],
    [{ po_id: PO, lines: [line({ item_id: ITEM, item_code: 'C' })] }, 'give item_id or item_code, not both'],
    [{ po_id: PO, lines: [line()], expected_totals: { total: 'x' } }, 'expected_totals.total must be a number'],
    [{ po_id: PO, lines: [line()], expected_totals: { vat: 1 } }, 'expected_totals.vat is not a field of this tool'],
    [{ po_id: PO, notes: 'x', expected_totals: { total: 1 } }, 'expected_totals checks the totals the new lines add up to: send lines with it'],
    [{ po_id: PO, notes: 'x', inclusive: true }, 'inclusive only changes how the new lines are priced: send lines with it'],
    [{ po_id: PO, lines: [line()], inclusive: 'y' }, 'inclusive must be true or false'],
  ])('refuses %j', (args, message) => {
    expect(parseUpdateArgs(args)).toContain(message);
  });

  it('accepts the transport\'s idempotency_key and the optional sections together', () => {
    expect(parseUpdateArgs({ idempotency_key: 'k', po_id: PO, supplier_id: SUP, lines: [line()], expected_totals: { subtotal: 20, tax_amount: 3, total: 23 }, inclusive: true }))
      .toMatchObject({ header: { supplierId: SUP }, inclusive: true, expected: { subtotal: 20, taxAmount: 3, total: 23 } });
  });
});

describe('parseMaintenanceArgs', () => {
  it('takes the selector, a trimmed reason and dry_run', () => {
    expect(parseMaintenanceArgs({ po_number: ' PO7 ', reason: '  why  ', dry_run: true })).toEqual({ poId: null, poNumber: 'PO7', reason: 'why', dryRun: true });
  });
  it.each([
    [{ reason: 'x' }, 'give exactly one of po_id and po_number'],
    [{ po_id: PO }, 'reason is required'],
    [{ po_id: PO, reason: '   ' }, 'reason is required'],
    [{ po_id: PO, reason: 'r'.repeat(501) }, 'reason is longer than 500 characters'],
    [{ po_id: PO, reason: 'x', dry_run: 1 }, 'dry_run must be true or false'],
    [{ po_id: PO, reason: 'x', status: 'closed' }, 'arguments.status is not a field of this tool'],
  ])('refuses %j', (args, message) => {
    expect(parseMaintenanceArgs(args)).toContain(message);
  });
  it('a tool\'s own extra key is allowed', () => {
    expect(parseMaintenanceArgs({ po_id: PO, reason: 'x', status: 'closed' }, ['status'])).toMatchObject({ poId: PO });
  });
});
