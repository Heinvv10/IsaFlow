/** The batches of a plan, the caps against the tools' own, and the one call that sends a batch (a fake session answers). */
import { describe, expect, it } from 'vitest';
import { MAX_UPSERT_ROWS } from '@/modules/accounting/services/items/itemCatalogTypes';
import { MAX_PURCHASE_ORDERS } from '@/lib/mcp/tools/purchaseOrderImportArgs';
import { batchKey, MAX_ITEM_BATCH, MAX_PO_BATCH, RUN_TAG } from '@/modules/accounting/services/sage-migration/sageBatches';
import { checkRowsPresent, planBatches, sendBatch } from '@/modules/accounting/services/sage-migration/sageBatchRun';
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
const empty = (): Snapshot => ({ itemRefs: new Set(), poTotals: new Map(), stockMovements: 0, items: [], categories: [], supplierSageRefs: new Map(), poNumbers: new Map() });
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

  it('M3: the dry run calls categories, items and POs ALL live (inside its rolled-back transaction); none carries dry_run', async () => {
    const { s, sent } = fake();
    for (const b of [batches.categories[0]!, batches.items[0]!, batches.purchaseOrders[0]!]) await sendBatch(s, b, empty(), true);
    expect(sent.map((x) => [x.name, 'dry_run' in x.args])).toEqual([['upsert_item_category', false], ['bulk_upsert_items', false], ['bulk_create_purchase_orders', false]]);
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
  const batch = (toolReported: Record<string, unknown> | null) => ({ entity: 'purchase_order' as const, n: 1, size: 1, key: 'k', status: 'ok' as const, allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported, error: null });
  it('lists the POs each batch answered would_have_failed, with their reasons, across batches', () => {
    const r = budgetWouldHaveFailed([
      batch({ would_have_failed: [{ index: 0, po_number: 'PO1', reasons: ['over by 10'] }] }),
      batch(null), batch({ created: 2 }),
      batch({ would_have_failed: [{ index: 1, po_number: 'PO4', reasons: [] }, { index: 2, po_number: 'PO5', reasons: ['a', 'b'] }] }),
    ]);
    expect(r).toEqual([{ poNumber: 'PO1', reasons: ['over by 10'] }, { poNumber: 'PO4', reasons: [] }, { poNumber: 'PO5', reasons: ['a', 'b'] }]);
  });
});

describe('F5: --run-tag and rows absent after a replay', () => {
  const rows = [{ a: 1 }];
  it('a tag changes the key; the same tag gives the same key; no tag is the key it always was', () => {
    expect(batchKey('item', 1, rows, 'r2')).not.toBe(batchKey('item', 1, rows));
    expect(batchKey('item', 1, rows, 'r2')).toBe(batchKey('item', 1, rows, 'r2'));
    expect(batchKey('item', 1, rows, 'r2')).not.toBe(batchKey('item', 1, rows, 'r3'));
    expect(batchKey('item', 1, rows, undefined)).toBe(batchKey('item', 1, rows));
    expect(batchKey('item', 1, rows, 'r2')).toMatch(/^sage-mig-item-0001-[0-9a-f]{16}$/);
  });
  it('the tag is on every batch key the plan makes, dry run included', async () => {
    const b = planBatches(plan(2, 2, 1), { runTag: 'r2' });
    const { s } = (() => { const sent: string[] = []; return { s: { companyId: 'c', call: async (_n: string, a: Record<string, unknown>) => { sent.push(String(a.idempotency_key)); return { isError: false, text: '{}', body: {} }; } } as ToolSession, sent }; })();
    const keys = [];
    for (const x of [b.categories[0]!, b.items[0]!, b.purchaseOrders[0]!]) keys.push((await sendBatch(s, x, empty(), true)).key, (await sendBatch(s, x, empty(), false)).key);
    const plain = planBatches(plan(2, 2, 1), {});
    for (const [i, x] of [plain.categories[0]!, plain.items[0]!, plain.purchaseOrders[0]!].entries()) {
      expect(keys[2 * i + 1]).not.toBe((await sendBatch(s, x, empty(), false)).key);
      expect(keys[2 * i]).toBe(`${keys[2 * i + 1]}-dry`);
    }
  });
  it('the tag is letters, digits, - and _ up to 32', () => {
    for (const ok of ['a', 'again-1', 'A_b', 'x'.repeat(32)]) expect(RUN_TAG.test(ok), ok).toBe(true);
    for (const bad of ['', 'a b', 'x'.repeat(33), 'a;b', '../x']) expect(RUN_TAG.test(bad), bad).toBe(false);
  });
  const batch = (size: number) => planBatches(plan(size, size), {});
  const ok = (size: number) => ({ entity: 'item' as const, n: 1, size, key: 'k', status: 'ok' as const, allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: {}, error: null });
  it('a batch whose rows are all there stays ok', () => {
    const after = { ...empty(), itemRefs: new Set(['1', '2']) };
    expect(checkRowsPresent(ok(2), batch(2).items[0]!, after)).toEqual(ok(2));
  });
  it('a batch the tool answered whose rows are gone fails, counts them, and names the remedy', () => {
    const after = { ...empty(), itemRefs: new Set(['1']) };
    const r = checkRowsPresent(ok(2), batch(2).items[0]!, after);
    expect(r).toMatchObject({ status: 'failed', rowsAbsent: 1 });
    expect(r.error).toMatch(/replayed, rows absent: 1 of 2 rows/);
    expect(r.error).toMatch(/--run-tag/);
    expect(r.error).toContain('k');
  });
  it('a batch that already failed is left as it was, and a PO batch is read by PO reference', () => {
    const failed = { ...ok(2), status: 'failed' as const, error: 'the tool said no' };
    expect(checkRowsPresent(failed, batch(2).items[0]!, empty())).toEqual(failed);
    const po = { ...ok(2), entity: 'purchase_order' as const };
    expect(checkRowsPresent(po, batch(2).purchaseOrders[0]!, { ...empty(), poTotals: new Map([['1', 1], ['2', 1]]) })).toEqual(po);
    expect(checkRowsPresent(po, batch(2).purchaseOrders[0]!, empty())).toMatchObject({ status: 'failed', rowsAbsent: 2 });
  });
});
