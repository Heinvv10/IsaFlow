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

const ctx = { userId: 'u1', companyId: 'c1', scopes: ['write:invoices'], tokenJti: null, oauthAppId: null, companyRole: 'owner' } as unknown as McpToolContext;
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
  prepareMock.mockReset().mockResolvedValue({ items: [{ index: 0 }], warnings: [], warningsByIndex: new Map() });
  store.client = {};
});

describe('bulk_create_purchase_orders handler', () => {
  it('refuses a malformed batch before preparing anything', async () => {
    const r = await tool.handler({ idempotency_key: 'k', purchase_orders: [] }, ctx);
    expect(r).toMatchObject({ isError: true, content: [{ text: 'purchase_orders must be a non-empty array' }] });
    expect(prepareMock).not.toHaveBeenCalled();
    const bad = await tool.handler({ idempotency_key: 'k', purchase_orders: [{ ...PO, supplier_id: 'acme' }] }, ctx);
    expect(bad).toMatchObject({ isError: true, content: [{ text: 'purchase_orders[0].supplier_id must be a supplier UUID' }] });
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

    importMock.mockRejectedValue(new BudgetExceededError('PO0000197 is over budget on BB-6100.', {
      companyId: 'c1', documentType: 'purchase_order', documentId: 'p1', documentRef: 'PO0000197', policy: 'block',
      lines: [], reason: null, channel: 'mcp', actorId: 'u1',
    }));
    const refused = await call({});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^budget_exceeded: PO0000197 is over budget on BB-6100\. Nothing was created/);

    importMock.mockRejectedValue(new Error('boom'));
    await expect(call({})).rejects.toThrow('boom');
  });
});

describe('bulk_create_purchase_orders: budget_check in the dry run and skip_budget_check_for_import', () => {
  const check = (over: Record<string, unknown> = {}) => ({ outcome: 'ok', policy: 'block', reasons: [], skipped: false, would_have_failed: false, ...over });
  const blockedPo = (skipped: boolean) => created({ budget_check: check({ outcome: 'block', reasons: ['Over budget: BB-6100'], skipped, would_have_failed: true }) });

  it('is owner / admin only: refused before the batch is parsed, prepared or run, in a dry run too', async () => {
    for (const companyRole of ['manager', 'viewer', null, undefined]) {
      for (const dry_run of [false, true]) {
        const r = await tool.handler({ idempotency_key: 'k', purchase_orders: [], skip_budget_check_for_import: true, dry_run }, { ...ctx, companyRole } as McpToolContext);
        expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('only an owner or admin may do') }] });
      }
    }
    expect(prepareMock).not.toHaveBeenCalled();
    expect(importMock).not.toHaveBeenCalled();
    expect(await call({ skip_budget_check_for_import: 'yes' })).toMatchObject({ isError: true, content: [{ text: 'skip_budget_check_for_import must be true or false' }] });
  });

  it('an owner or admin passes the flag and dry_run to the service', async () => {
    importMock.mockResolvedValue(created());
    for (const companyRole of ['owner', 'admin']) {
      await tool.handler({ idempotency_key: 'k', purchase_orders: [PO], skip_budget_check_for_import: true, dry_run: true }, { ...ctx, companyRole } as McpToolContext);
      expect(importMock.mock.calls.at(-1)![2]).toMatchObject({ skipBudgetCheck: true, dryRun: true });
    }
    await call({});
    expect(importMock.mock.calls.at(-1)![2]).toMatchObject({ skipBudgetCheck: false, dryRun: false });
  });

  it('a dry run with a PO the live call would refuse is would_succeed false and lists it; the other POs keep their own check', async () => {
    importMock.mockResolvedValue({
      purchaseOrders: [{ ...created().purchaseOrders[0], budget_check: check() }, { ...blockedPo(false).purchaseOrders[0], index: 1, po_number: 'PO0000198' }],
      counter: { prefix: 'PO', next_number: 199, raised: true },
    });
    const r = await call({ dry_run: true });
    expect(body(r)).toMatchObject({ dry_run: true, would_succeed: false, budget_blocked: [{ index: 1, po_number: 'PO0000198', reasons: ['Over budget: BB-6100'] }] });
    expect(body(r)).not.toHaveProperty('skip_budget_check_for_import');
    const pos = body(r).purchase_orders as Array<{ id: string | null; budget_check: { outcome: string } }>;
    expect(pos.map((p) => [p.id, p.budget_check.outcome])).toEqual([[null, 'ok'], [null, 'block']]);
    expect(r).toMatchObject({ wroteNothing: true, billable: false });
  });

  it('with the flag: would_succeed, and the POs the block would have refused are listed (dry run and live)', async () => {
    importMock.mockResolvedValue(blockedPo(true));
    const dry = await call({ dry_run: true, skip_budget_check_for_import: true });
    expect(body(dry)).toMatchObject({ would_succeed: true, skip_budget_check_for_import: true, would_have_failed: [{ index: 0, po_number: 'PO0000197', reasons: ['Over budget: BB-6100'] }] });
    expect(body(dry)).not.toHaveProperty('budget_blocked');
    const live = await call({ skip_budget_check_for_import: true });
    expect(body(live)).toMatchObject({ created: 1, skip_budget_check_for_import: true, would_have_failed: [{ index: 0 }] });
    importMock.mockResolvedValue(created({ budget_check: check({ skipped: true }) }));
    expect(body(await call({ skip_budget_check_for_import: true }))).toMatchObject({ would_have_failed: [] });
  });

  it('each created PO carries its own dimension_warnings (dry run and live), a replay none', async () => {
    prepareMock.mockResolvedValue({ items: [{ index: 0 }, { index: 1 }], warnings: ['purchase_orders[1].lines[0]: cos'], warningsByIndex: new Map([[1, ['purchase_orders[1].lines[0]: cos']]]) });
    importMock.mockResolvedValue({
      purchaseOrders: [{ ...created().purchaseOrders[0] }, { ...created().purchaseOrders[0], index: 1, id: 'p2', po_number: 'PO0000198' }],
      counter: { prefix: 'PO', next_number: 199, raised: true },
    });
    const dry = await call({ dry_run: true });
    expect((body(dry).purchase_orders as Array<Record<string, unknown>>).map((p) => p.dimension_warnings)).toEqual([undefined, ['purchase_orders[1].lines[0]: cos']]);
    expect(body(dry).dimension_warnings).toEqual(['purchase_orders[1].lines[0]: cos']);
    const live = await call({});
    expect((body(live).purchase_orders as Array<Record<string, unknown>>).map((p) => p.dimension_warnings)).toEqual([undefined, ['purchase_orders[1].lines[0]: cos']]);
  });
});
