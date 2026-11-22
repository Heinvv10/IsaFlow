/** The batches of a plan, the caps against the tools' own, and the one call that sends a batch (a fake session answers). */
import { describe, expect, it } from 'vitest';
import { MAX_UPSERT_ROWS } from '@/modules/accounting/services/items/itemCatalogTypes';
import { MAX_PURCHASE_ORDERS } from '@/lib/mcp/tools/purchaseOrderImportArgs';
import { MAX_ITEM_BATCH, MAX_PO_BATCH } from '@/modules/accounting/services/sage-migration/sageBatches';
import { planBatches, sendBatch } from '@/modules/accounting/services/sage-migration/sageBatchRun';
import { budgetWouldHaveFailed } from '@/modules/accounting/services/sage-migration/sageBudgetReport';
import type { MigrationPlan } from '@/modules/accounting/services/sage-migration/sageMigrationPlan';
import type { Snapshot } from '@/modules/accounting/services/sage-migration/sageSnapshot';
import type { ToolOutcome, ToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

const plan = (items: number, pos: number, categories = 0): MigrationPlan => ({
  categories: Array.from({ length: categories }, (_, i) => ({ name: `C${i}` })),
  items: Array.from({ length: items }, (_, i) => ({ sageId: String(i + 1), row: { code: `I${i}` } })),
  purchaseOrders: Array.from({ length: pos }, (_, i) => ({ sageId: String(i + 1), documentNumber: `PO${i}`, totalCents: 1, element: { po_number: `PO${i}` }, pdfFile: null })),
  refusals: [],
});
const empty = (): Snapshot => ({ itemRefs: new Set(), poTotals: new Map(), stockMovements: 0, items: [], poNumbers: new Map() });
const sizes = (b: { size: number }[]) => b.map((x) => x.size);

describe('the caps are the tools\' own', () => {
  it('500 items and 100 purchase orders a call, equal to what bulk_upsert_items and bulk_create_purchase_orders accept', () => {
    expect(MAX_ITEM_BATCH).toBe(MAX_UPSERT_ROWS);
    expect(MAX_PO_BATCH).toBe(MAX_PURCHASE_ORDERS);
  });
  it('501 items go 500 + 1 and 101 POs go 100 + 1, in order, each batch numbered from 1', () => {
    const b = planBatches(plan(501, 101), {});
    expect(sizes(b.items)).toEqual([500, 1]);
    expect(sizes(b.purchaseOrders)).toEqual([100, 1]);
    expect(b.items.map((x) => x.n)).toEqual([1, 2]);
    expect((b.items[0]!.args.items as unknown[]).length).toBe(500);
    expect((b.purchaseOrders[1]!.args.purchase_orders as Array<{ po_number: string }>)[0]!.po_number).toBe('PO100');
  });
  it('exactly 500 items and exactly 100 POs are one batch each; none is no batch', () => {
    const b = planBatches(plan(500, 100), {});
    expect([b.items.length, b.purchaseOrders.length]).toEqual([1, 1]);
    const none = planBatches(plan(0, 0), {});
    expect([none.items.length, none.purchaseOrders.length]).toEqual([0, 0]);
  });
  it('a size above the cap is cut to the cap, a smaller one is used, and one category is one call', () => {
    expect(sizes(planBatches(plan(501, 101), { itemBatchSize: 9999, poBatchSize: 9999 }).items)).toEqual([500, 1]);
    expect(sizes(planBatches(plan(10, 7), { itemBatchSize: 4, poBatchSize: 3 }).purchaseOrders)).toEqual([3, 3, 1]);
    expect(planBatches(plan(0, 0, 3), {}).categories.map((c) => [c.tool, c.size])).toEqual(Array(3).fill(['upsert_item_category', 1]));
  });
  it('skip_budget_check_for_import is on the PO calls only when asked', () => {
    expect(planBatches(plan(1, 1), {}).purchaseOrders[0]!.args).not.toHaveProperty('skip_budget_check_for_import');
    expect(planBatches(plan(1, 1), { skipBudgetCheck: true }).purchaseOrders[0]!.args.skip_budget_check_for_import).toBe(true);
    expect(planBatches(plan(1, 1), { skipBudgetCheck: true }).items[0]!.args).not.toHaveProperty('skip_budget_check_for_import');
  });
});

describe('sendBatch', () => {
  const fake = (answer: Partial<ToolOutcome> = {}) => {
    const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
    const s: ToolSession = {
      companyId: 'c',
      call: async (name, args) => { sent.push({ name, args }); return { isError: false, text: '{}', body: {}, ...answer }; },
    };
    return { s, sent };
  };
  const batches = planBatches(plan(2, 2, 1), {});

  it('the dry run calls categories and POs LIVE (inside its rolled-back transaction) and items with dry_run', async () => {
    const { s, sent } = fake();
    for (const b of [batches.categories[0]!, batches.items[0]!, batches.purchaseOrders[0]!]) await sendBatch(s, b, empty(), true);
    expect(sent.map((x) => [x.name, x.args.dry_run])).toEqual([['upsert_item_category', undefined], ['bulk_upsert_items', true], ['bulk_create_purchase_orders', undefined]]);
  });
  it('the live run never sets dry_run', async () => {
    const { s, sent } = fake();
    for (const b of [batches.categories[0]!, batches.items[0]!, batches.purchaseOrders[0]!]) await sendBatch(s, b, empty(), false);
    expect(sent.every((x) => !('dry_run' in x.args))).toBe(true);
  });
  it('a dry-run key is its own (-dry) and a live key is the plain deterministic one', async () => {
    const { s } = fake();
    const dry = await sendBatch(s, batches.items[0]!, empty(), true);
    const live = await sendBatch(s, batches.items[0]!, empty(), false);
    expect(dry.key).toBe(`${live.key}-dry`);
    expect(live.key).toMatch(/^sage-mig-item-0001-[0-9a-f]{16}$/);
  });
  it('keeps the tool\'s WHOLE refusal text in the batch report, however long', async () => {
    const long = `refused: ${'x'.repeat(20_000)}`;
    const r = await sendBatch(fake({ isError: true, text: long, body: null }).s, batches.purchaseOrders[0]!, empty(), false);
    expect(r).toMatchObject({ status: 'failed', toolReported: null });
    expect(r.error).toBe(long);
  });
  it('flags a batch whose rows are all in the books already', async () => {
    const before = { ...empty(), itemRefs: new Set(['1', '2']) };
    expect((await sendBatch(fake().s, batches.items[0]!, before, false)).allRowsAlreadyPresent).toBe(true);
    expect((await sendBatch(fake().s, batches.items[0]!, empty(), false)).allRowsAlreadyPresent).toBe(false);
  });
});

describe('budgetWouldHaveFailed', () => {
  const batch = (toolReported: Record<string, unknown> | null) => ({ entity: 'purchase_order' as const, n: 1, size: 1, key: 'k', status: 'ok' as const, allRowsAlreadyPresent: false, toolReported, error: null });
  it('lists the POs each batch answered would_have_failed, with their reasons, across batches', () => {
    const r = budgetWouldHaveFailed([
      batch({ would_have_failed: [{ index: 0, po_number: 'PO1', reasons: ['over by 10'] }] }),
      batch(null), batch({ created: 2 }),
      batch({ would_have_failed: [{ index: 1, po_number: 'PO4', reasons: [] }, { index: 2, po_number: 'PO5', reasons: ['a', 'b'] }] }),
    ]);
    expect(r).toEqual([{ poNumber: 'PO1', reasons: ['over by 10'] }, { poNumber: 'PO4', reasons: [] }, { poNumber: 'PO5', reasons: ['a', 'b'] }]);
  });
});
