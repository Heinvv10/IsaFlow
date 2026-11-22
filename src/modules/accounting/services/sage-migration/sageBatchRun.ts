/**
 * The batches of a plan (categories one call each, item batches <= 500, PO batches <= 100) and the one call that sends a batch.
 * The caps are the tools' own (bulk_upsert_items 500, bulk_create_purchase_orders 100); a test pins them equal.
 */
import type { BatchEntity, BatchReport, MigrationOptions } from './sageMigrationTypes';
import { MAX_ITEM_BATCH, MAX_PO_BATCH, batchKey, chunk } from './sageBatches';
import type { MigrationPlan } from './sageMigrationPlan';
import type { Snapshot } from './sageSnapshot';
import type { ToolSession } from './sageToolSession';

export interface Send {
  entity: BatchEntity;
  n: number;
  tool: string;
  args: Record<string, unknown>;
  size: number;
  /** Every row of the batch was in the books before this run. */
  present: (before: Snapshot) => boolean;
}

export interface PlannedBatches { categories: Send[]; items: Send[]; purchaseOrders: Send[] }

export function planBatches(plan: MigrationPlan, opts: Pick<MigrationOptions, 'itemBatchSize' | 'poBatchSize' | 'skipBudgetCheck'>): PlannedBatches {
  const itemSize = Math.min(opts.itemBatchSize ?? MAX_ITEM_BATCH, MAX_ITEM_BATCH);
  const poSize = Math.min(opts.poBatchSize ?? MAX_PO_BATCH, MAX_PO_BATCH);
  const categories = plan.categories.map((args, i): Send => ({
    entity: 'category', n: i + 1, tool: 'upsert_item_category', args, size: 1, present: () => false,
  }));
  const items = chunk(plan.items, itemSize).map((rows, i): Send => ({
    entity: 'item', n: i + 1, tool: 'bulk_upsert_items', args: { items: rows.map((r) => r.row) }, size: rows.length,
    present: (before) => rows.every((r) => before.itemRefs.has(r.sageId)),
  }));
  const purchaseOrders = chunk(plan.purchaseOrders, poSize).map((rows, i): Send => ({
    entity: 'purchase_order', n: i + 1, tool: 'bulk_create_purchase_orders', size: rows.length,
    args: { purchase_orders: rows.map((r) => r.element), ...(opts.skipBudgetCheck ? { skip_budget_check_for_import: true } : {}) },
    present: (before) => rows.every((r) => before.poTotals.has(r.sageId)),
  }));
  return { categories, items, purchaseOrders };
}

/**
 * Sends one batch. In the DRY RUN (a request transaction the runner rolls back) categories and purchase orders are called LIVE,
 * and items with dry_run: the categories must exist for the items' preview, and a PO batch must see the POs of the batches
 * before it, as the live run's budget check will (a dry_run PO batch rolls itself back, so batch k would not). Nothing the dry
 * run does survives its transaction, idempotency and audit rows included; its keys carry "-dry" as well.
 */
export async function sendBatch(session: ToolSession, s: Send, before: Snapshot, dry: boolean): Promise<BatchReport> {
  const key = batchKey(s.entity, s.n, s.args) + (dry ? '-dry' : '');
  const r = await session.call(s.tool, { ...s.args, idempotency_key: key, ...(dry && s.entity === 'item' ? { dry_run: true } : {}) });
  return {
    entity: s.entity, n: s.n, size: s.size, key, status: r.isError ? 'failed' : 'ok',
    allRowsAlreadyPresent: s.present(before) || (s.entity === 'category' && r.body?.outcome === 'unchanged'),
    toolReported: r.isError ? null : r.body,
    // The tool's whole message: the JSON report keeps it; only the console summary is cut.
    error: r.isError ? r.text : null,
  };
}
