/**
 * create_goods_received / cancel_goods_received / list_goods_received / get_goods_received around their services: argument
 * refusals before any service call, what reaches the agent for each typed refusal, the dry run (rolled back, key left free), and
 * the registration. The writes and every database rule run against real PostgreSQL in tests/integration/mcp-goods-received*.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { receiveMock, cancelMock, rolledBack, store } = vi.hoisted(() => ({
  receiveMock: vi.fn(), cancelMock: vi.fn(), rolledBack: vi.fn(), store: { client: {} as unknown },
}));
vi.mock('@/lib/als', () => ({ als: { getStore: () => store } }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: async (name: string, fn: () => Promise<unknown>) => { rolledBack(name); await fn(); },
}));
vi.mock('@/modules/accounting/services/ap/goodsReceivedService', () => ({ receiveGoods: (...a: unknown[]) => receiveMock(...a) }));
vi.mock('@/modules/accounting/services/ap/goodsReceivedCancel', () => ({ CANCEL_REASON_MAX: 500, cancelGoodsReceived: (...a: unknown[]) => cancelMock(...a) }));

import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import { GoodsReceivedError } from '@/modules/accounting/services/ap/goodsReceivedValidation';
import type { McpToolContext } from '@/lib/mcp/types';

const PO = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const GRN = '33333333-3333-4333-8333-333333333333';
const ctx = { userId: 'u1', companyId: 'c1', scopes: ['write:invoices'], tokenJti: null, oauthAppId: null, companyRole: 'manager' } as unknown as McpToolContext;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const json = (r: { content: { text: string }[] }) => JSON.parse(text(r)) as Record<string, unknown>;
const args = (over: Record<string, unknown> = {}) => ({ idempotency_key: 'k', po_id: PO, received_date: '2026-06-20', lines: [{ po_item_id: LINE, quantity_received: 2 }], ...over });
const received = {
  receipt: { id: GRN, grn_number: 'GRN-00007' }, poNumber: 'PO1', poStatusBefore: 'approved', poStatusAfter: 'partially_received',
  items: [{ poItemId: LINE, quantityReceived: 2, quantityRejected: 0 }],
};

beforeEach(() => {
  for (const m of [receiveMock, cancelMock, rolledBack]) m.mockReset();
  store.client = {};
});

describe('registration', () => {
  it('two write:invoices writes needing an idempotency_key and two read:invoices reads, all free; the refusal code is registered', () => {
    for (const name of ['create_goods_received', 'cancel_goods_received']) {
      const t = MCP_TOOLS.find((x) => x.name === name)!;
      expect(t, name).toMatchObject({ scope: 'write:invoices', write: true });
      expect(t.inputSchema.required).toContain('idempotency_key');
      expect(flowOperationFor(name, {}), name).toBeNull();
    }
    for (const name of ['list_goods_received', 'get_goods_received']) {
      expect(MCP_TOOLS.find((x) => x.name === name), name).toMatchObject({ scope: 'read:invoices', write: false });
      expect(flowOperationFor(name, {}), name).toBeNull();
    }
    expect(REFUSAL_CODES).toContain('GOODS_RECEIVED_REFUSED');
    expect(new GoodsReceivedError('x').code).toBe('GOODS_RECEIVED_REFUSED');
  });
});

describe('create_goods_received', () => {
  it.each([
    [{ po_id: 'nope' }, 'po_id is required'],
    [{ received_date: '2026-02-31' }, 'received_date is required'],
    [{ lines: [] }, 'lines is required'],
    [{ lines: [{ po_item_id: LINE, quantity_received: -1 }] }, 'lines[0].quantity_received must be a number of at least 0'],
    [{ lines: [{ po_item_id: LINE, quantity_received: 1, colour: 'red' }] }, 'lines[0].colour is not a field'],
    [{ external_system: 'fibreflow' }, 'external_system and external_ref go together'],
    [{ dry_run: 'yes' }, 'dry_run must be true or false'],
    [{ grn_number: 'GRN-1' }, 'arguments.grn_number is not a field'],
  ])('%o is refused before the service: %s', async (over, message) => {
    const r = await create.handler(args(over), ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(message);
    expect(receiveMock).not.toHaveBeenCalled();
  });

  it('a live create answers the note and passes the reference lower case and the via', async () => {
    receiveMock.mockResolvedValue(received);
    const r = await create.handler(args({ external_system: 'FibreFlow', external_ref: 4411 }), ctx);
    expect(json(r)).toMatchObject({ created: true, grn_id: GRN, grn_number: 'GRN-00007', po_status: 'partially_received', posted_to_ledger: false, external_system: 'fibreflow', external_ref: '4411' });
    expect(r.wroteNothing).toBeUndefined();
    expect(receiveMock).toHaveBeenCalledWith('c1', 'u1', expect.objectContaining({ purchaseOrderId: PO, items: [expect.objectContaining({ poItemId: LINE, quantityReceived: 2 })] }),
      { via: 'mcp:create_goods_received', external: { system: 'fibreflow', ref: '4411' } });
    expect(rolledBack).not.toHaveBeenCalled();
  });

  it('a dry run runs the service in a rolled-back savepoint, reports grn_number "next" and leaves the key free', async () => {
    receiveMock.mockResolvedValue(received);
    const r = await create.handler(args({ dry_run: true }), ctx);
    expect(json(r)).toMatchObject({ dry_run: true, would_create: true, grn_id: null, grn_number: 'next' });
    expect(r).toMatchObject({ wroteNothing: true, billable: false });
    expect(rolledBack).toHaveBeenCalledWith('create_goods_received_dry');
    store.client = undefined;
    expect(text(await create.handler(args({ dry_run: true }), ctx))).toBe('dry_run needs a request transaction');
  });

  it('a typed refusal is JSON with its code and every refused line; anything else is thrown', async () => {
    receiveMock.mockRejectedValue(new GoodsReceivedError('Received quantity exceeds the outstanding order quantity', 'over_receipt', {
      lines: [{ index: 0, poItemId: LINE, code: 'over_receipt', outstanding: 1, asked: 2 }, { index: 1, poItemId: PO, code: 'line_not_on_po' }],
    }));
    const r = await create.handler(args(), ctx);
    expect(r.isError).toBe(true);
    expect(json(r)).toEqual({
      refused: true, code: 'over_receipt', message: 'Received quantity exceeds the outstanding order quantity', written: false, dry_run: false,
      lines: [{ index: 0, po_item_id: LINE, code: 'over_receipt', outstanding: 1, asked: 2 }, { index: 1, po_item_id: PO, code: 'line_not_on_po' }],
    });
    receiveMock.mockRejectedValue(new GoodsReceivedError('Purchase order not found', 'not_found'));
    expect(json(await create.handler(args(), ctx))).toMatchObject({ code: 'not_found', message: 'Not found' });
    receiveMock.mockRejectedValue(new GoodsReceivedError('dup', 'duplicate_external_ref', { existing: { id: GRN, grnNumber: 'GRN-00001' } }));
    expect(json(await create.handler(args(), ctx))).toMatchObject({ code: 'duplicate_external_ref', existing_goods_received: { id: GRN, grn_number: 'GRN-00001' } });
    receiveMock.mockRejectedValue(new Error('boom'));
    await expect(create.handler(args(), ctx)).rejects.toThrow('boom');
  });
});

describe('cancel_goods_received', () => {
  const cancelled = { grnId: GRN, grnNumber: 'GRN-00007', poId: PO, poNumber: 'PO1', poStatusBefore: 'received', poStatusAfter: 'partially_received', items: [] };
  it.each([
    [{ grn_id: 'x' }, 'grn_id is required'],
    [{ reason: '  ' }, 'reason is required'],
    [{ reason: 'r'.repeat(501) }, 'reason is longer than 500'],
    [{ po_id: PO }, 'arguments.po_id is not a field'],
  ])('%o is refused before the service: %s', async (over, message) => {
    const r = await cancel.handler({ idempotency_key: 'k', grn_id: GRN, reason: 'r', ...over }, ctx);
    expect(text(r)).toContain(message);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('live, dry run, and a refusal naming the bills', async () => {
    cancelMock.mockResolvedValue(cancelled);
    expect(json(await cancel.handler({ idempotency_key: 'k', grn_id: GRN, reason: ' wrong PO ' }, ctx))).toMatchObject({ cancelled: true, status: 'cancelled', po_status: 'partially_received' });
    expect(cancelMock).toHaveBeenCalledWith('c1', GRN, ' wrong PO ', { userId: 'u1', via: 'mcp:cancel_goods_received' });
    const dry = await cancel.handler({ idempotency_key: 'k', grn_id: GRN, reason: 'x', dry_run: true }, ctx);
    expect(dry).toMatchObject({ wroteNothing: true, billable: false });
    expect(json(dry)).toMatchObject({ dry_run: true, would_cancel: true });
    cancelMock.mockRejectedValue(new GoodsReceivedError('on a bill', 'grn_on_bill', { bills: [{ id: PO, invoiceNumber: 'INV-1' }], billsTotal: 1 }));
    expect(json(await cancel.handler({ idempotency_key: 'k', grn_id: GRN, reason: 'x' }, ctx))).toMatchObject({
      code: 'grn_on_bill', bills: [{ id: PO, invoice_number: 'INV-1' }], bills_total: 1, written: false,
    });
  });
});
