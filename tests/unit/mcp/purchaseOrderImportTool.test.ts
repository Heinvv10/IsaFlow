/**
 * bulk_create_purchase_orders' handler around its service: what reaches the agent for each outcome. The writes and
 * every database rule are covered against real PostgreSQL in tests/integration/mcp-purchase-order-import*.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const importMock = vi.fn();
const prepareMock = vi.fn();
const store = { client: {} as unknown };
vi.mock('@/lib/neon', () => ({ withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn(), sql: vi.fn() }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => store } }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderImport', async (orig) => ({
  ...(await orig<object>()), importPurchaseOrders: (...a: unknown[]) => importMock(...a),
}));
vi.mock('@/lib/mcp/tools/purchaseOrderImportPrepare', () => ({ preparePurchaseOrders: (...a: unknown[]) => prepareMock(...a) }));

import { bulkCreatePurchaseOrdersTool as tool } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import { PurchaseOrderImportRefusal } from '@/modules/accounting/services/ap/purchaseOrderImport';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = { userId: 'u1', companyId: 'c1', scopes: ['write:invoices'], tokenJti: null, oauthAppId: null } as unknown as McpToolContext;
const PO = {
  po_number: 'PO0000197', supplier_id: '11111111-1111-4111-8111-111111111111', order_date: '2026-06-10',
  lines: [{ description: 'Cable', quantity: 1, unit_price: 10 }],
};
const created = (over: Record<string, unknown> = {}) => ({
  purchaseOrders: [{ index: 0, id: 'p1', po_number: 'PO0000197', status: 'draft', subtotal: 10, tax_amount: 1.5, total: 11.5, already_existed: false, ...over }],
  counter: { prefix: 'PO', next_number: 198, raised: true },
});
const call = (args: Record<string, unknown>) => tool.handler({ idempotency_key: 'k', purchase_orders: [PO], ...args }, ctx);
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

beforeEach(() => {
  importMock.mockReset();
  prepareMock.mockReset().mockResolvedValue({ items: [{ index: 0 }], warnings: [] });
  store.client = {};
});

describe('bulk_create_purchase_orders handler', () => {
  it('refuses a malformed batch before preparing anything', async () => {
    const r = await tool.handler({ idempotency_key: 'k', purchase_orders: [] }, ctx);
    expect(r).toMatchObject({ isError: true, content: [{ text: 'purchase_orders must be a non-empty array' }] });
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('returns a prepare refusal as the tool error', async () => {
    prepareMock.mockResolvedValue('Not found');
    expect(await call({})).toMatchObject({ isError: true, content: [{ text: 'Not found' }] });
    expect(importMock).not.toHaveBeenCalled();
  });

  it('a created batch occupies the key; one that found every PO already there (counter unmoved) leaves it free', async () => {
    importMock.mockResolvedValue(created());
    const first = await call({});
    expect(body(first)).toMatchObject({ created: 1, already_existed: 0, counter: { next_number: 198 } });
    expect(first.wroteNothing).toBeUndefined();
    importMock.mockResolvedValue({ ...created({ already_existed: true }), counter: { prefix: 'PO', next_number: 198, raised: false } });
    const again = await call({});
    expect(body(again)).toMatchObject({ created: 0, already_existed: 1 });
    expect(again).toMatchObject({ wroteNothing: true, billable: false });
  });

  it('a re-run that still had to raise the counter is not write-free', async () => {
    importMock.mockResolvedValue(created({ already_existed: true }));
    expect((await call({})).wroteNothing).toBeUndefined();
  });

  it('dry_run reports with null ids for what it would create and writes nothing', async () => {
    importMock.mockResolvedValue(created());
    const r = await call({ dry_run: true });
    expect(body(r)).toMatchObject({ dry_run: true, would_create: 1, already_existed: 0, purchase_orders: [{ id: null }] });
    expect(r).toMatchObject({ wroteNothing: true, billable: false });
  });

  it('dry_run with no request transaction is refused: the rollback would undo nothing', async () => {
    store.client = undefined;
    expect(await call({ dry_run: true })).toMatchObject({ isError: true, content: [{ text: 'dry_run needs a request transaction' }] });
    expect(importMock).not.toHaveBeenCalled();
  });

  it('a number already in the books and a budget block are tool errors; anything else propagates', async () => {
    importMock.mockRejectedValue(new PurchaseOrderImportRefusal('purchase_orders[0]: po_number PO0000197 already exists'));
    expect(await call({})).toMatchObject({ isError: true, content: [{ text: 'purchase_orders[0]: po_number PO0000197 already exists' }] });

    const budget = Object.create(BudgetExceededError.prototype) as BudgetExceededError;
    Object.defineProperty(budget, 'message', { value: 'PO0000197 is over budget on BB-6100.' });
    importMock.mockRejectedValue(budget);
    const refused = await call({});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^budget_exceeded: PO0000197 is over budget on BB-6100\. Nothing was created/);

    importMock.mockRejectedValue(new Error('boom'));
    await expect(call({})).rejects.toThrow('boom');
  });
});
