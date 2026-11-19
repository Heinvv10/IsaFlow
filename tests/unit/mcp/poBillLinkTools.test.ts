/**
 * link_bills_to_purchase_order / unlink_bill_from_purchase_order / get_purchase_order around their services: what reaches the agent
 * for each outcome, the registration of the three tools, and the size of the widest get_purchase_order reply. Writes and every
 * database rule run against real PostgreSQL in tests/integration/mcp-po-bill-links*.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const linkMock = vi.fn();
const unlinkMock = vi.fn();
const detailMock = vi.fn();
const rolledBack = vi.fn();
const store = { client: {} as unknown };
vi.mock('@/lib/neon', () => ({ withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn(), sql: vi.fn() }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => store } }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: async (name: string, fn: () => Promise<unknown>) => { rolledBack(name); await fn(); },
}));
vi.mock('@/modules/accounting/services/ap/purchaseOrderBillLink', () => ({ linkBillsToPurchaseOrders: (...a: unknown[]) => linkMock(...a) }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderBillUnlink', () => ({ unlinkBillFromPurchaseOrder: (...a: unknown[]) => unlinkMock(...a) }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderDetailService', async (orig) => ({
  ...(await orig<object>()), readPurchaseOrderDetail: (...a: unknown[]) => detailMock(...a),
}));

import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import { PurchaseOrderBillLinkRefusal } from '@/modules/accounting/services/ap/purchaseOrderBillLinkTypes';
import { DETAIL_CAPS } from '@/modules/accounting/services/ap/purchaseOrderDetailService';
import type { McpToolContext } from '@/lib/mcp/types';

const PO = '11111111-1111-4111-8111-111111111111';
const BILL = '22222222-2222-4222-8222-222222222222';
const ctx = { userId: 'u1', companyId: 'c1', scopes: ['write:invoices'], tokenJti: null, oauthAppId: null } as unknown as McpToolContext;
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const done = (over: Record<string, unknown> = {}) => ({
  links: [{ index: 0, linkId: 'l1', poId: PO, poNumber: 'PO1', billId: BILL, invoiceNumber: 'B1', amountCents: 10050, linesLinked: 0, alreadyExisted: false, externalSystem: null, externalRef: null, ...over }],
  purchaseOrders: [{ poId: PO, poNumber: 'PO1', statusBefore: 'approved', statusAfter: 'closed', billedCents: 10050, subtotalCents: 10050, fullyBilled: true }],
});

beforeEach(() => {
  for (const m of [linkMock, unlinkMock, detailMock, rolledBack]) m.mockReset();
  store.client = {};
});

describe('link_bills_to_purchase_order handler', () => {
  const call = (args: Record<string, unknown>) => link.handler({ idempotency_key: 'k', links: [{ po_id: PO, bill_id: BILL }], ...args }, ctx);

  it('refuses a malformed call listing every bad row, before any service call', async () => {
    const r = await call({ links: [{ po_id: PO, bill_id: BILL }, { bill_id: BILL }, { po_id: PO, bill_id: 'x' }] });
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0]!.text).toBe('2 of 3 links cannot be made; nothing was linked. links[1]: give exactly one of po_id and po_number; links[2]: bill_id must be a supplier invoice UUID');
    expect(linkMock).not.toHaveBeenCalled();
    expect(await call({ links: [] })).toMatchObject({ isError: true });
    expect(await call({ close_when_fully_billed: 'yes' })).toMatchObject({ isError: true, content: [{ text: 'close_when_fully_billed must be true or false' }] });
    expect(await call({ dry_run: 1 })).toMatchObject({ isError: true, content: [{ text: 'dry_run must be true or false' }] });
    expect(linkMock).not.toHaveBeenCalled();
  });

  it('passes the company, the parsed links and the options to the service; the token user is the actor', async () => {
    linkMock.mockResolvedValue(done());
    await call({ close_when_fully_billed: true });
    expect(linkMock).toHaveBeenCalledWith('c1', [expect.objectContaining({ index: 0, poId: PO, billId: BILL })],
      { userId: 'u1', source: 'mcp', via: 'mcp:link_bills_to_purchase_order', closeWhenFullyBilled: true });
    expect(rolledBack).not.toHaveBeenCalled();
  });

  it('a call that linked occupies the key; one that found every pair already linked leaves it free and is not billable', async () => {
    linkMock.mockResolvedValue(done());
    const first = await call({});
    expect(body(first)).toMatchObject({ linked: 1, already_existed: 0, links: [{ link_id: 'l1', amount: 100.5 }], purchase_orders: [{ status: 'closed', closed_by_this_call: true, fully_billed: true }] });
    expect(first.wroteNothing).toBeUndefined();
    linkMock.mockResolvedValue(done({ alreadyExisted: true }));
    const again = await call({});
    expect(body(again)).toMatchObject({ linked: 0, already_existed: 1 });
    expect(again).toMatchObject({ wroteNothing: true, billable: false });
  });

  it('dry_run runs the service in the rolled-back savepoint, hides the ids it would make and leaves the key free', async () => {
    linkMock.mockResolvedValue(done());
    const r = await call({ dry_run: true });
    expect(rolledBack).toHaveBeenCalledWith('po_bill_link_dry');
    expect(body(r)).toMatchObject({ dry_run: true, would_link: 1, already_existed: 0, links: [{ link_id: null }] });
    expect(r).toMatchObject({ wroteNothing: true, billable: false });
  });

  it('dry_run with no request transaction is refused: the rollback would undo nothing', async () => {
    store.client = undefined;
    expect(await call({ dry_run: true })).toMatchObject({ isError: true, content: [{ text: 'dry_run needs a request transaction' }] });
    expect(linkMock).not.toHaveBeenCalled();
  });

  it('the service\'s refusal is a tool error (live and dry alike); anything else propagates', async () => {
    linkMock.mockRejectedValue(new PurchaseOrderBillLinkRefusal('1 of 1 links cannot be made; nothing was linked. links[0]: bill not found'));
    for (const dry of [false, true]) {
      expect(await call({ dry_run: dry })).toMatchObject({ isError: true, content: [{ text: '1 of 1 links cannot be made; nothing was linked. links[0]: bill not found' }] });
    }
    linkMock.mockRejectedValue(new Error('boom'));
    await expect(call({})).rejects.toThrow('boom');
  });
});

describe('unlink_bill_from_purchase_order handler', () => {
  const call = (args: Record<string, unknown>) => unlink.handler({ idempotency_key: 'k', po_id: PO, bill_id: BILL, reason: 'wrong PO', ...args }, ctx);
  const result = { poId: PO, poNumber: 'PO1', billId: BILL, invoiceNumber: 'B1', linkId: 'l1', amountCents: 5000, linesCleared: 2, poStatusBefore: 'closed', poStatusAfter: 'received', reopenedTo: 'received' };

  it('refuses a bad selector, bill, reason and flag before any service call', async () => {
    for (const args of [{ po_id: undefined }, { po_id: PO, po_number: 'PO1' }, { bill_id: 'x' }, { reason: ' ' }, { reason: 'r'.repeat(501) }, { dry_run: 'y' }]) {
      expect(await call(args)).toMatchObject({ isError: true });
    }
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('unlinks as the token user with the reason; dry_run rolls back and leaves the key free', async () => {
    unlinkMock.mockResolvedValue(result);
    const live = await call({});
    expect(unlinkMock).toHaveBeenCalledWith('c1', { poId: PO, poNumber: null, billId: BILL, reason: 'wrong PO' }, 'u1', 'mcp:unlink_bill_from_purchase_order');
    expect(body(live)).toMatchObject({ unlinked: true, amount: 50, lines_cleared: 2, reopened_to: 'received' });
    expect(live.wroteNothing).toBeUndefined();
    const dry = await call({ dry_run: true });
    expect(rolledBack).toHaveBeenCalledWith('po_bill_unlink_dry');
    expect(body(dry)).toMatchObject({ dry_run: true, would_unlink: true });
    expect(dry).toMatchObject({ wroteNothing: true, billable: false });
  });

  it('a refusal is a tool error; anything else propagates', async () => {
    unlinkMock.mockRejectedValue(new PurchaseOrderBillLinkRefusal('Bill B1 is not linked to purchase order PO1'));
    expect(await call({})).toMatchObject({ isError: true, content: [{ text: 'Bill B1 is not linked to purchase order PO1' }] });
    unlinkMock.mockRejectedValue(new Error('boom'));
    await expect(call({})).rejects.toThrow('boom');
  });
});

describe('get_purchase_order handler', () => {
  const read = { scopes: ['read:invoices'] } as unknown as McpToolContext;
  it('refuses a missing / double selector and a bad id; a miss reads "Not found"', async () => {
    expect(await getPo.handler({}, read)).toMatchObject({ isError: true });
    expect(await getPo.handler({ po_id: 'nope' }, read)).toMatchObject({ isError: true });
    expect(detailMock).not.toHaveBeenCalled();
    detailMock.mockResolvedValue(null);
    expect(await getPo.handler({ po_number: 'PO1' }, { ...read, companyId: 'c1' } as McpToolContext)).toMatchObject({ isError: true, content: [{ text: 'Not found' }] });
    expect(detailMock).toHaveBeenCalledWith('c1', { poId: null, poNumber: 'PO1' }, 0);
    expect(await getPo.handler({ po_number: 'PO1', offset: -1 }, read)).toMatchObject({ isError: true });
  });

  it('the widest reply (every list at its cap, long names) fits a client\'s result limit', async () => {
    const long = "x".repeat(150);
    const row = (i: number) => ({ id: crypto.randomUUID(), description: `${long.slice(0, 150)}${i}`, quantity_ordered: 1234567.89, quantity_received: 1234567.89, quantity_billed: 1234567.89,
      unit_price: 1234567.123456, tax_rate: 15, line_total: 12345678901.23, tax_amount: 1234567.89, amount_billed: 12345678901.23,
      outstanding_quantity_to_receive: 1234567.89, outstanding_quantity_to_bill: 1234567.89, outstanding_amount_to_bill: 12345678901.23, gl_account_id: crypto.randomUUID() });
    const bill = () => ({ link_id: crypto.randomUUID(), bill_id: crypto.randomUUID(), invoice_number: 'INV'.repeat(16), status: 'partially_paid', invoice_date: '2026-06-15',
      subtotal: 12345678901.23, total_amount: 12345678901.23, linked_amount: 12345678901.23, counts_as_billed: true, source: 'backfill', external_system: 'x'.repeat(32), external_ref: 'y'.repeat(128) });
    const grn = () => ({ id: crypto.randomUUID(), grn_number: 'GRN-00001', received_date: '2026-06-15', status: 'accepted', received_by: 'z'.repeat(100),
      items: Array.from({ length: Math.floor(DETAIL_CAPS.grnItems / DETAIL_CAPS.grns) }, () => ({ po_item_id: crypto.randomUUID(), quantity_received: 1234567.89, quantity_rejected: 1234567.89 })) });
    const doc = () => ({ id: crypto.randomUUID(), name: 'n'.repeat(150), document_type: 'purchase_order', mime_type: 'application/pdf', size: 123456789, uploaded_at: '2026-06-15T10:00:00.000Z' });
    detailMock.mockResolvedValue({
      purchase_order: { id: PO, po_number: 'P'.repeat(50), notes: 'n'.repeat(500), reference: 'r'.repeat(150), supplier_name: 's'.repeat(255) },
      lines: Array.from({ length: DETAIL_CAPS.lines }, (_, i) => row(i)), lines_total: 9999, next_offset: 9999,
      bills: Array.from({ length: DETAIL_CAPS.bills }, bill), bills_total: 9999,
      goods_received_notes: Array.from({ length: DETAIL_CAPS.grns }, grn), goods_received_notes_total: 9999,
      documents: Array.from({ length: DETAIL_CAPS.documents }, doc), documents_total: 9999,
      billed_total: 1, outstanding_to_bill: 1, fully_billed: false,
    });
    const r = await getPo.handler({ po_id: PO }, { ...read, companyId: 'c1' } as McpToolContext);
    expect(r.isError).toBeUndefined();
    expect(Buffer.byteLength(r.content[0]!.text)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });
});

describe('registration', () => {
  const byName = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
  it('the writes need write:invoices and are write tools; the read needs read:invoices and is not', () => {
    expect(byName('link_bills_to_purchase_order')).toMatchObject({ scope: 'write:invoices', write: true });
    expect(byName('unlink_bill_from_purchase_order')).toMatchObject({ scope: 'write:invoices', write: true });
    expect(byName('get_purchase_order')).toMatchObject({ scope: 'read:invoices', write: false });
  });
  it('the refusal class code reaches the agent', () => {
    expect(REFUSAL_CODES.has(new PurchaseOrderBillLinkRefusal('x').code)).toBe(true);
  });
});
