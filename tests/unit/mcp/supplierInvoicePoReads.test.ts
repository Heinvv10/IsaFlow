/**
 * list_supplier_invoices / get_supplier_invoice carry the purchase orders a bill is linked to (migration 1006), and
 * get_supplier_invoice the three-way match (only the lines that name a PO line, capped). The widest get_supplier_invoice
 * reply (200 lines, 50 of them with long text matched) stays under MAX_READ_RESULT_BYTES.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getInvoices = vi.fn();
const getInvoice = vi.fn();
const poIds = vi.fn();
const threeWay = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  getSupplierInvoices: (...a: unknown[]) => getInvoices(...a), getSupplierInvoiceById: (...a: unknown[]) => getInvoice(...a),
}));
vi.mock('@/modules/accounting/services/ap/billPurchaseOrderLinks', () => ({ purchaseOrderIdsByBill: (...a: unknown[]) => poIds(...a) }));
vi.mock('@/modules/accounting/services/ap/threeWayMatchState', () => ({ readThreeWayMatchState: (...a: unknown[]) => threeWay(...a) }));

import { getSupplierInvoiceTool as getBill, listSupplierInvoicesTool as listBills } from '@/lib/mcp/tools/supplierInvoices';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = { userId: 'u', companyId: 'c1', scopes: ['read:invoices'], tokenJti: null, oauthAppId: null } as unknown as McpToolContext;
const BILL = 'bill-1';
const inv = (over: Record<string, unknown> = {}) => ({
  id: BILL, invoiceNumber: 'INV-1', supplierId: 's1', invoiceDate: '2026-06-15', subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 0, balance: 115,
  status: 'approved', items: [], ...over,
});
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

beforeEach(() => {
  for (const m of [getInvoices, getInvoice, poIds, threeWay]) m.mockReset();
  poIds.mockResolvedValue(new Map());
  threeWay.mockResolvedValue(null);
});

describe('list_supplier_invoices', () => {
  it('names the purchase orders of each bill of the page (none: an empty list), asking for the page\'s ids once', async () => {
    getInvoices.mockResolvedValue({ invoices: [inv(), inv({ id: 'bill-2' })], total: 2 });
    poIds.mockResolvedValue(new Map([['bill-1', ['po-a', 'po-b']]]));
    const r = body(await listBills.handler({}, ctx)) as { invoices: Array<Record<string, unknown>> };
    expect(r.invoices.map((i) => i.purchase_order_ids)).toEqual([['po-a', 'po-b'], []]);
    expect(poIds).toHaveBeenCalledTimes(1);
    expect(poIds).toHaveBeenCalledWith('c1', ['bill-1', 'bill-2']);
  });
});

describe('get_supplier_invoice', () => {
  const line = (n: number, poItemId?: string) => ({ id: `l${n}`, description: `Line ${n}`, quantity: 1, unitPrice: 10, taxRate: 15, taxAmount: 1.5, lineTotal: 10, ...(poItemId ? { poItemId } : {}) });
  const matchLine = (n: number) => ({
    invoiceItemId: `l${n}`, description: 'd'.repeat(200), poQuantity: 1, invoiceQuantity: 1, grnQuantityReceived: 1, poUnitPrice: 10, invoiceUnitPrice: 10,
    qtyVariancePct: 0, priceVariancePct: 0, lineMatchStatus: 'fully_matched', mismatches: ['Unit price differs by 12.34% from the purchase order (allowed 2%)'],
  });
  const state = (n: number) => ({
    invoiceId: BILL, matchStatus: 'fully_matched', paymentMatched: false, paymentMatchedAt: null, hasPurchaseOrder: true,
    summary: { totalLines: n, fullyMatched: n, priceMismatches: 0, quantityMismatches: 0, grnMismatches: 0 },
    itemResults: Array.from({ length: n }, (_, i) => matchLine(i)), tolerancesApplied: { qtyTolerancePct: 2, priceTolerancePct: 2 },
  });

  it('adds purchase_order_ids, po_item_id on each line and the three-way match of the lines that name a PO line', async () => {
    getInvoice.mockResolvedValue(inv({ items: [line(0, 'pi-0'), line(1)] }));
    poIds.mockResolvedValue(new Map([[BILL, ['po-a']]]));
    threeWay.mockResolvedValue(state(2));
    const r = body(await getBill.handler({ invoice_id: '11111111-1111-4111-8111-111111111111' }, ctx)) as Record<string, unknown>;
    expect(r.purchase_order_ids).toEqual(['po-a']);
    expect((r.items as Array<Record<string, unknown>>).map((i) => i.po_item_id)).toEqual(['pi-0', null]);
    expect(r.three_way).toMatchObject({
      status: 'fully_matched', has_purchase_order: true, lines_total: 1, lines_without_po_line: 1, tolerances: { quantity_percent: 2, price_percent: 2 },
      lines: [{ invoice_item_id: 'l0', status: 'fully_matched', quantity: { po: 1, grn: 1, invoice: 1, variance_percent: 0 }, unit_price: { po: 10, invoice: 10 } }],
    });
  });

  it('a bill the match cannot read (null) has three_way null; a bill with no PO line names none', async () => {
    getInvoice.mockResolvedValue(inv({ items: [line(0)] }));
    expect((body(await getBill.handler({ invoice_id: '11111111-1111-4111-8111-111111111111' }, ctx)) as Record<string, unknown>).three_way).toBeNull();
    threeWay.mockResolvedValue({ ...state(1), matchStatus: 'unmatched', hasPurchaseOrder: false, itemResults: [] });
    expect((body(await getBill.handler({ invoice_id: '11111111-1111-4111-8111-111111111111' }, ctx)) as { three_way: Record<string, unknown> }).three_way)
      .toMatchObject({ status: 'unmatched', has_purchase_order: false, lines_total: 0, lines: [] });
  });

  it('the widest reply (200 lines of 100 characters, all matched) fits a client\'s result limit and says what it cut', async () => {
    getInvoice.mockResolvedValue(inv({ items: Array.from({ length: 200 }, (_, i) => ({ ...line(i, `pi-${i}`), description: 'x'.repeat(100) })), notes: 'n'.repeat(2000) }));
    poIds.mockResolvedValue(new Map([[BILL, Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)]]));
    threeWay.mockResolvedValue(state(200));
    const res = await getBill.handler({ invoice_id: '11111111-1111-4111-8111-111111111111' }, ctx);
    expect(Buffer.byteLength(res.content[0]!.text)).toBeLessThan(MAX_READ_RESULT_BYTES);
    const three = (body(res) as { three_way: { lines: unknown[]; lines_total: number } }).three_way;
    expect(three.lines).toHaveLength(30);
    expect(three.lines_total).toBe(200);
  });
});
