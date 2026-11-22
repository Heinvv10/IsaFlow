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
  /** The Sage ids of this batch's rows that are not in `after` (none for a category). */
  absent: (after: Snapshot) => string[];
  runTag?: string;
}

export interface PlannedBatches { categories: Send[]; items: Send[]; purchaseOrders: Send[] }

export function planBatches(plan: MigrationPlan, opts: Pick<MigrationOptions, 'itemBatchSize' | 'poBatchSize' | 'skipBudgetCheck' | 'runTag'>): PlannedBatches {
  const itemSize = Math.min(opts.itemBatchSize ?? MAX_ITEM_BATCH, MAX_ITEM_BATCH);
  const poSize = Math.min(opts.poBatchSize ?? MAX_PO_BATCH, MAX_PO_BATCH);
  const categories = plan.categories.map((args, i): Send => ({
    entity: 'category', n: i + 1, tool: 'upsert_item_category', args, size: 1, present: () => false, absent: () => [], runTag: opts.runTag,
  }));
  const items = chunk(plan.items, itemSize).map((rows, i): Send => ({
    entity: 'item', n: i + 1, tool: 'bulk_upsert_items', args: { items: rows.map((r) => r.row) }, size: rows.length,
    present: (before) => rows.every((r) => before.itemRefs.has(r.sageId)),
    absent: (after) => rows.map((r) => r.sageId).filter((id) => !after.itemRefs.has(id)), runTag: opts.runTag,
  }));
  const purchaseOrders = chunk(plan.purchaseOrders, poSize).map((rows, i): Send => ({
    entity: 'purchase_order', n: i + 1, tool: 'bulk_create_purchase_orders', size: rows.length,
    args: { purchase_orders: rows.map((r) => r.element), ...(opts.skipBudgetCheck ? { skip_budget_check_for_import: true } : {}) },
    present: (before) => rows.every((r) => before.poTotals.has(r.sageId)),
    absent: (after) => rows.map((r) => r.sageId).filter((id) => !after.poTotals.has(id)), runTag: opts.runTag,
  }));
  return { categories, items, purchaseOrders };
}

/**
 * Sends one batch. The DRY RUN is the live run inside a request transaction the runner rolls back: every tool is called LIVE (no
 * dry_run flag), so the items' preview finds their categories, a PO batch sees the POs of the batches before it as the live run's
 * budget check will (a dry_run PO batch rolls itself back, so batch k would not), and the same code and constraints run as in the
 * live call. Nothing the dry run does survives its transaction, idempotency and audit rows included (tests prove it); its keys carry
 * "-dry" as well, so even a failed rollback could not make the live run replay a dry run's answer.
 */
export async function sendBatch(session: ToolSession, s: Send, before: Snapshot, dry: boolean): Promise<BatchReport> {
  const key = batchKey(s.entity, s.n, s.args, s.runTag) + (dry ? '-dry' : '');
  const r = await session.call(s.tool, { ...s.args, idempotency_key: key });
  return {
    entity: s.entity, n: s.n, size: s.size, key, status: r.isError ? 'failed' : 'ok',
    allRowsAlreadyPresent: s.present(before) || (s.entity === 'category' && r.body?.outcome === 'unchanged'), rowsAbsent: 0,
    toolReported: r.isError ? null : r.body,
    // The tool's whole message: the JSON report keeps it; only the console summary is cut.
    error: r.isError ? r.text : null,
  };
}

/**
 * After a LIVE run: a batch the tool answered "ok" whose rows are not in the books is a replayed answer (the registry keeps the
 * answer of an earlier run under the batch's key, and that run's rows have since been deleted). It is marked failed, with the
 * remedy, rather than reported as done. Returns the batch as reported.
 */
export function checkRowsPresent(b: BatchReport, s: Send, after: Snapshot): BatchReport {
  if (b.status !== 'ok') return b;
  const absent = s.absent(after).length;
  if (absent === 0) return b;
  return {
    ...b, status: 'failed', rowsAbsent: absent,
    error: `replayed, rows absent: ${absent} of ${b.size} rows of this batch are not in the books, although the tool answered. If an earlier run of this file `
      + `imported them and they were deleted since, the batch's key (${b.key}) still holds that run's answer and replays it, writing nothing. `
      + 'Restore the rows, or run again with --run-tag <text> for a deliberate fresh import under new keys.',
  };
}
