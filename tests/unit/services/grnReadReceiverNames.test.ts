// The MCP reads (list_goods_received, get_goods_received) and the PO detail's GRN list name the receiver, not the user id:
// a note whose received_by is its creator's id answers with that user's name; typed text stays as typed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const U1 = '3f2b8c1e-9d4a-4e7b-8a61-0c5d2e7f9a10';
const PO = '11111111-1111-4111-8111-111111111111';
const GRN = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ route: (_text: string): unknown[] => [] }));
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray) => Promise.resolve(h.route(strings.join('?'))),
}));
import { listGoodsReceived, readGoodsReceivedDetail } from '@/modules/accounting/services/ap/goodsReceivedReadService';
import { readPurchaseOrderDetail } from '@/modules/accounting/services/ap/purchaseOrderDetailService';

const note = (over: Record<string, unknown>) => ({
  id: GRN, grn_number: 'GRN-00001', status: 'received', received_date: '2026-06-15', received_by: U1, created_by: U1, notes: null,
  purchase_order_id: PO, po_number: 'PO1', po_status: 'approved', supplier_id: null, supplier_name: null, external_system: null, external_ref: null,
  cancelled_at: null, cancelled_by: null, cancel_reason: null, created_at: '2026-06-15T10:00:00Z', line_count: 0, document_count: 0, total_rows: 2, ...over,
});
const names = (text: string) => (text.includes('unnest') ? [{ id: U1, name: 'Sam Receiver' }] : null);
beforeEach(() => { h.route = () => []; });

describe('MCP / PO detail Received By', () => {
  it('list_goods_received answers the name for a creator-defaulted note and keeps typed text', async () => {
    h.route = (t: string) => names(t) ?? (t.includes('count(*) OVER ()') ? [note({}), note({ id: 'g2', received_by: 'Gate guard' })] : []);
    const out = await listGoodsReceived('c1', { poId: null, supplierId: null, dateFrom: null, dateTo: null, externalRef: null, statuses: null }, { limit: 25, offset: 0 });
    expect(out.rows.map((r) => r.received_by)).toEqual(['Sam Receiver', 'Gate guard']);
    expect(JSON.stringify(out.rows)).not.toContain(U1);
  });
  it('get_goods_received answers the name in the note header', async () => {
    h.route = (t: string) => names(t) ?? (t.includes('SELECT g.*, po.po_number') ? [note({})] : []);
    const out = await readGoodsReceivedDetail('c1', GRN);
    expect(out!.goods_received_note.received_by).toBe('Sam Receiver');
  });
  it('the PO detail lists each GRN with the receiver\'s name', async () => {
    const head = { id: PO, po_number: 'PO1', supplier_id: 's', status: 'approved', subtotal: 0, tax_amount: 0, total: 0 };
    h.route = (t: string) => names(t) ?? (t.includes('FROM purchase_orders po') && t.includes('supplier_name') ? [head]
      : t.includes('FROM goods_received_notes g WHERE g.company_id') ? [note({})] : []);
    const out = await readPurchaseOrderDetail('c1', { poId: PO, poNumber: null });
    expect(out!.goods_received_notes.map((g) => g.received_by)).toEqual(['Sam Receiver']);
  });
});
