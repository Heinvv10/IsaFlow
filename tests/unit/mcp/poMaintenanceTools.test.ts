/**
 * update / cancel / close / set status of a purchase order around their services: what reaches the agent for each outcome, the roles,
 * the dry run, and the registration of the four tools. The writes and every database rule run against real PostgreSQL in
 * tests/integration/mcp-po-maintenance*.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, prepareMock, cancelMock, closeMock, setMock, recordRefusal, rolledBack, sqlMock, store } = vi.hoisted(() => ({
  updateMock: vi.fn(), prepareMock: vi.fn(), cancelMock: vi.fn(), closeMock: vi.fn(), setMock: vi.fn(), recordRefusal: vi.fn(),
  rolledBack: vi.fn(), sqlMock: vi.fn(), store: { client: {} as unknown },
}));
vi.mock('@/lib/neon', () => ({ withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn(), sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => store } }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: async (name: string, fn: () => Promise<unknown>) => { rolledBack(name); await fn(); },
}));
vi.mock('@/modules/accounting/services/budgets/budgetCheck', () => ({ recordBudgetRefusal: (...a: unknown[]) => recordRefusal(...a) }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderUpdate', async (orig) => ({ ...(await orig<object>()), updatePurchaseOrder: (...a: unknown[]) => updateMock(...a) }));
vi.mock('@/lib/mcp/tools/purchaseOrderUpdatePrepare', () => ({ prepareUpdate: (...a: unknown[]) => prepareMock(...a) }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderMaintenance', () => ({
  cancelPurchaseOrder: (...a: unknown[]) => cancelMock(...a), closePurchaseOrder: (...a: unknown[]) => closeMock(...a),
}));
vi.mock('@/modules/accounting/services/ap/purchaseOrderSetStatus', async (orig) => ({
  ...(await orig<object>()), setImportedPurchaseOrderStatus: (...a: unknown[]) => setMock(...a),
}));

import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { cancelPurchaseOrderTool as cancel } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { closePurchaseOrderTool as close } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import { PurchaseOrderNotCancellableError } from '@/modules/accounting/services/ap/purchaseOrderCancel';
import { PurchaseOrderMaintenanceRefusal, PurchaseOrderNotFoundError, PurchaseOrderChangedError } from '@/modules/accounting/services/ap/purchaseOrderErrors';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import type { McpToolContext } from '@/lib/mcp/types';

const PO = '11111111-1111-4111-8111-111111111111';
const ctx = (companyRole: string | null = 'owner', scopes = ['write:invoices']) => ({ userId: 'u1', companyId: 'c1', scopes, tokenJti: null, oauthAppId: null, companyRole }) as unknown as McpToolContext;
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const blocked = () => new BudgetExceededError('Over budget — approval refused.', {
  companyId: 'c1', documentType: 'purchase_order', documentId: PO, documentRef: 'PO1', policy: 'block', lines: [], reason: null, channel: 'mcp', actorId: 'u1',
});

beforeEach(() => {
  for (const m of [updateMock, prepareMock, cancelMock, closeMock, setMock, recordRefusal, rolledBack, sqlMock]) m.mockReset();
  sqlMock.mockResolvedValue([{ id: PO }]);
  store.client = {};
});

describe('registration', () => {
  const NAMES = ['update_purchase_order', 'cancel_purchase_order', 'close_purchase_order', 'set_purchase_order_status'];
  it('all four are write:invoices writes needing an idempotency_key, free of Flows, and the maintenance refusal code is registered', () => {
    for (const name of NAMES) {
      const t = MCP_TOOLS.find((x) => x.name === name)!;
      expect(t, name).toMatchObject({ scope: 'write:invoices', write: true });
      expect(t.inputSchema.required).toContain('idempotency_key');
      expect(flowOperationFor(name, {}), name).toBeNull();
    }
    expect(REFUSAL_CODES).toContain('PURCHASE_ORDER_MAINTENANCE_REFUSED');
    expect(new PurchaseOrderMaintenanceRefusal('x').code).toBe('PURCHASE_ORDER_MAINTENANCE_REFUSED');
  });
});

describe('update_purchase_order handler', () => {
  const call = (args: Record<string, unknown>, c = ctx()) => update.handler({ idempotency_key: 'k', po_id: PO, notes: 'n', ...args }, c);
  const result = { poId: PO, poNumber: 'PO1', status: 'approved', changedFields: ['notes'], linesReplaced: null, subtotal: 100, taxAmount: 15, total: 115, budgetChecked: false, budgetWarnings: [] as string[] };

  it('refuses malformed arguments before preparing or writing anything; dry_run needs the request transaction', async () => {
    expect(await call({ notes: undefined })).toMatchObject({ isError: true });
    expect(prepareMock).not.toHaveBeenCalled();
    store.client = undefined;
    expect(await call({ dry_run: true })).toMatchObject({ isError: true, content: [{ text: 'dry_run needs a request transaction' }] });
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('editing an APPROVED PO is owner / admin only: a manager is refused after one status read, before the edit is prepared (dry run too); a draft is open to them', async () => {
    sqlMock.mockResolvedValue([{ id: PO, status: 'approved' }]);
    for (const dry of [false, true]) {
      expect(await call({ dry_run: dry }, ctx('manager'))).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('only an owner or admin may do') }] });
    }
    expect(prepareMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    sqlMock.mockResolvedValue([{ id: PO, status: 'draft' }]);
    prepareMock.mockResolvedValue({ request: { poId: PO, header: {}, replace: null }, warnings: [] });
    updateMock.mockResolvedValue(result);
    await call({}, ctx('manager'));
    expect(updateMock.mock.calls.at(-1)![2]).toMatchObject({ mayEditApproved: false });
    await call({}, ctx('admin'));
    expect(updateMock.mock.calls.at(-1)![2]).toMatchObject({ mayEditApproved: true });
  });

  it('a prepare refusal is the tool error and nothing is written', async () => {
    prepareMock.mockResolvedValue('lines[0].item_code: no item with the code "X" in this company');
    expect(await call({})).toMatchObject({ isError: true, content: [{ text: 'lines[0].item_code: no item with the code "X" in this company' }] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('updates as the token user; the live reply occupies the key, a dry run rolls back and leaves it free', async () => {
    prepareMock.mockResolvedValue({ request: { poId: PO, header: { notes: 'n' }, replace: null }, warnings: ['lines[0]: cost-of-sales line with no project'] });
    updateMock.mockResolvedValue(result);
    const live = await call({});
    expect(updateMock).toHaveBeenCalledWith('c1', { poId: PO, header: { notes: 'n' }, replace: null }, { userId: 'u1', via: 'mcp:update_purchase_order', budgetFigures: false, mayEditApproved: true });
    expect(body(live)).toMatchObject({ updated: true, po_number: 'PO1', total: 115, budget_warning: null, dimension_warnings: ['lines[0]: cost-of-sales line with no project'] });
    expect(live.wroteNothing).toBeUndefined();
    const dry = await call({ dry_run: true });
    expect(rolledBack).toHaveBeenCalledWith('update_purchase_order_dry');
    expect(body(dry)).toMatchObject({ dry_run: true, would_update: true });
    expect(dry).toMatchObject({ wroteNothing: true, billable: false });
  });

  it('typed refusals are tool errors; a budget block is recorded live and only reported in a dry run; anything else propagates', async () => {
    prepareMock.mockResolvedValue({ request: { poId: PO, header: {}, replace: null }, warnings: [] });
    updateMock.mockRejectedValue(new PurchaseOrderMaintenanceRefusal('Bills are linked to this purchase order'));
    expect(await call({})).toMatchObject({ isError: true, content: [{ text: 'Bills are linked to this purchase order' }] });
    updateMock.mockRejectedValue(new PurchaseOrderNotFoundError());
    expect(text(await call({}))).toBe('Not found');
    updateMock.mockRejectedValue(new PurchaseOrderChangedError());
    expect(text(await call({}))).toContain('changed while it was being saved');
    updateMock.mockRejectedValue(blocked());
    const live = await call({});
    expect(text(live)).toMatch(/^budget_exceeded: Over budget/);
    expect(recordRefusal).toHaveBeenCalledTimes(1);
    expect(text(await call({ dry_run: true }))).toMatch(/^budget_exceeded:/);
    expect(recordRefusal).toHaveBeenCalledTimes(1);
    updateMock.mockRejectedValue(new Error('boom'));
    await expect(call({})).rejects.toThrow('boom');
  });
});

describe('cancel_purchase_order handler', () => {
  const call = (args: Record<string, unknown>, c = ctx()) => cancel.handler({ idempotency_key: 'k', po_id: PO, reason: 'dup', ...args }, c);
  it('needs a reason; a miss reads "Not found" before the service', async () => {
    expect(text(await call({ reason: ' ' }))).toContain('reason is required');
    sqlMock.mockResolvedValue([]);
    expect(text(await call({}))).toBe('Not found');
    expect(cancelMock).not.toHaveBeenCalled();
  });
  it('passes whether the caller may cancel an approved PO (owner / admin) and the typed refusals come back as tool errors', async () => {
    cancelMock.mockResolvedValue({ poId: PO, poNumber: 'PO1', statusBefore: 'draft', status: 'cancelled' });
    for (const [role, may] of [['owner', true], ['admin', true], ['manager', false], [null, false]] as const) {
      await call({}, ctx(role));
      expect(cancelMock.mock.calls.at(-1)![3], String(role)).toMatchObject({ mayCancelApproved: may, userId: 'u1', via: 'mcp:cancel_purchase_order' });
    }
    expect(body(await call({}))).toMatchObject({ cancelled: true, status_before: 'draft', status: 'cancelled' });
    cancelMock.mockRejectedValue(new PurchaseOrderNotCancellableError('Bills are linked to this purchase order, so it cannot be cancelled; unlink them first'));
    expect(await call({})).toMatchObject({ isError: true });
    cancelMock.mockRejectedValue(new PurchaseOrderMaintenanceRefusal('only an owner or admin'));
    expect(text(await call({}))).toBe('only an owner or admin');
  });
  it('dry_run rolls back and leaves the key free', async () => {
    cancelMock.mockResolvedValue({ poId: PO, poNumber: 'PO1', statusBefore: 'approved', status: 'cancelled' });
    const dry = await call({ dry_run: true });
    expect(rolledBack).toHaveBeenCalledWith('cancel_purchase_order_dry');
    expect(body(dry)).toMatchObject({ dry_run: true, would_cancel: true });
    expect(dry).toMatchObject({ wroteNothing: true, billable: false });
  });
});

describe('close_purchase_order handler', () => {
  const call = (args: Record<string, unknown>, c = ctx()) => close.handler({ idempotency_key: 'k', po_id: PO, reason: 'short', ...args }, c);
  const result = { poId: PO, poNumber: 'PO1', statusBefore: 'partially_received', status: 'closed', receivedCents: 4000, billedCents: 2500, remainingAmountCents: 6000,
    shortClosed: [{ poItemId: 'i1', description: 'Cable', orderedQty: 10, receivedQty: 4, remainingQty: 6, remainingAmountCents: 6000 }] };

  it('is owner / admin only, refused before any read, a dry run too', async () => {
    for (const role of ['manager', 'viewer', null]) {
      for (const dry of [false, true]) expect(await call({ dry_run: dry }, ctx(role))).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('only an owner or admin') }] });
    }
    expect(sqlMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });
  it('replies with the short-closed lines in rand and truncates a long list', async () => {
    closeMock.mockResolvedValue(result);
    const r = await call({}, ctx('admin'));
    expect(closeMock).toHaveBeenCalledWith('c1', PO, 'short', { userId: 'u1', via: 'mcp:close_purchase_order' });
    expect(body(r)).toMatchObject({
      closed: true, status_before: 'partially_received', received_amount: 40, billed_amount: 25, remaining_amount: 60, short_closed_lines_total: 1,
      short_closed_lines: [{ po_item_id: 'i1', ordered_qty: 10, received_qty: 4, remaining_qty: 6, remaining_amount: 60 }], short_closed_lines_truncated: false,
    });
    const many = Array.from({ length: 60 }, (_, i) => ({ ...result.shortClosed[0]!, poItemId: `i${i}` }));
    closeMock.mockResolvedValue({ ...result, shortClosed: many });
    expect(body(await call({}))).toMatchObject({ short_closed_lines_total: 60, short_closed_lines_truncated: true });
    expect((body(await call({})).short_closed_lines as unknown[]).length).toBe(50);
  });
  it('dry_run rolls back and leaves the key free', async () => {
    closeMock.mockResolvedValue(result);
    const dry = await call({ dry_run: true });
    expect(rolledBack).toHaveBeenCalledWith('close_purchase_order_dry');
    expect(dry).toMatchObject({ wroteNothing: true, billable: false });
    expect(body(dry)).toMatchObject({ dry_run: true, would_close: true });
  });
});

describe('set_purchase_order_status handler', () => {
  const call = (args: Record<string, unknown>, c = ctx()) => setStatus.handler({ idempotency_key: 'k', po_id: PO, status: 'closed', reason: 'Sage: Invoiced', ...args }, c);
  const result = { poId: PO, poNumber: 'PO1', statusBefore: 'approved', status: 'closed', closedFromStatus: 'approved', budgetWarnings: [] as string[] };

  it('refuses a bad status, a missing reason and a non-owner / admin before any read', async () => {
    expect(text(await call({ status: 'received' }))).toBe('status must be one of draft, approved, closed, cancelled');
    expect(text(await call({ status: undefined }))).toBe('status must be one of draft, approved, closed, cancelled');
    expect(text(await call({ reason: '' }))).toContain('reason is required');
    for (const role of ['manager', 'viewer', null]) expect(text(await call({}, ctx(role)))).toContain('only an owner or admin');
    expect(sqlMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });
  it('sets the status as the token user; budget warnings come back; dry_run rolls back and leaves the key free', async () => {
    setMock.mockResolvedValue({ ...result, status: 'approved', closedFromStatus: null, budgetWarnings: ['Over budget: BB-6100'] });
    const live = await call({ status: 'approved' }, ctx('owner', ['write:invoices', 'read:reports']));
    expect(setMock).toHaveBeenCalledWith('c1', PO, 'approved', 'Sage: Invoiced', { userId: 'u1', via: 'mcp:set_purchase_order_status', budgetFigures: true });
    expect(body(live)).toMatchObject({ status_set: true, status: 'approved', budget_warning: 'Over budget: BB-6100' });
    setMock.mockResolvedValue(result);
    const dry = await call({ dry_run: true });
    expect(rolledBack).toHaveBeenCalledWith('set_purchase_order_status_dry');
    expect(body(dry)).toMatchObject({ dry_run: true, would_set: true, closed_from_status: 'approved' });
    expect(dry).toMatchObject({ wroteNothing: true, billable: false });
  });
  it('a refusal is a tool error and a budget block is recorded live', async () => {
    setMock.mockRejectedValue(new PurchaseOrderMaintenanceRefusal('Bills are linked to this purchase order, so it cannot go to cancelled'));
    expect(await call({ status: 'cancelled' })).toMatchObject({ isError: true });
    setMock.mockRejectedValue(blocked());
    expect(text(await call({ status: 'approved' }))).toMatch(/^budget_exceeded:/);
    expect(recordRefusal).toHaveBeenCalledTimes(1);
  });
});
