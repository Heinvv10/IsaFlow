/**
 * The batches of a plan (categories one call each, item batches <= 500, PO batches <= 100) and the one call that sends a batch.
 * The caps are the tools' own (bulk_upsert_items 500, bulk_create_purchase_orders 100); a test pins them equal.
 */
import { createHash } from 'node:crypto';
import type { BatchEntity, BatchReport, MigrationOptions } from './sageMigrationTypes';
import { MAX_ITEM_BATCH, MAX_PO_BATCH, batchKey, chunk } from './sageBatches';
import type { MigrationPlan } from './sageMigrationPlan';
import type { SentCategory, SentItem } from './sageOwnership';
import type { ExistingCategory, ExistingItem, Snapshot } from './sageSnapshot';
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
  /** How a person knows a row of this batch (item code, category name, PO number), by its Sage id. */
  labelOf: (sageId: string) => string;
  runTag?: string;
  /** The items of an item batch, in order (`index` of the tool's answer): for the ownership check of the dry run. */
  itemRows?: Array<{ sageId: string; code: string }>;
  /** What the batch sends for each item, to check the books after the items phase. */
  itemSent?: SentItem[];
  /** The Sage id of the category of a category send: its key follows the owned category's state, and the books are checked against `categorySent`. */
  categoryRef?: string;
  /** The Sage ids of the POs of a PO batch: its key follows the state of those already in the books. */
  poRefs?: string[];
  categorySent?: SentCategory;
}

/**
 * THE salt of a batch key, for every entity: a hash of the state of the existing rows the batch touches, given as (reference, state hash)
 * pairs where a reference with no row has no hash. With no existing row there is no salt and the key is the plain one, so a batch whose
 * rows are absent (a first run, a failed batch, rows deleted) is retried under its own key. Once a row of the batch has changed in IsaFlow
 * (or been written by the run that stored an answer) the key differs, so a stored answer is replayed only under exactly the state it
 * was given for: never an answer that was true of an earlier state.
 */
export function stateSalt(states: ReadonlyArray<readonly [string, string | undefined]>): string | undefined {
  const mine = states.flatMap(([ref, hash]) => (hash === undefined ? [] : [`${ref}:${hash}`])).sort();
  return mine.length === 0 ? undefined : createHash('sha256').update(mine.join('|')).digest('hex').slice(0, 16);
}

/** An item batch: the OWNED (system sage, live) rows it touches. */
export function itemBatchSalt(rows: ReadonlyArray<{ sageId: string }>, existing: readonly ExistingItem[]): string | undefined {
  return stateSalt(rows.map((r) => [r.sageId, existing.find((i) => i.system === 'sage' && i.ref === r.sageId && !i.deleted)?.stateHash] as const));
}

/** The salt of a category send's key: the state hash of the owned category (system sage, this Sage id), as for an item batch. */
export function categoryBatchSalt(sageId: string, existing: readonly ExistingCategory[]): string | undefined {
  return stateSalt([[sageId, existing.find((x) => x.system === 'sage' && x.ref === sageId)?.stateHash]]);
}

/** A PO batch: the Sage POs it touches that are already in the books. */
export function poBatchSalt(sageIds: readonly string[], poStates: ReadonlyMap<string, string>): string | undefined {
  return stateSalt(sageIds.map((id) => [id, poStates.get(id)] as const));
}

/** The idempotency key a batch is sent under (a dry run's carries "-dry"). */
export function keyFor(s: Send, before: Snapshot, dry: boolean): string {
  const salt = s.itemRows ? itemBatchSalt(s.itemRows, before.items) : s.categoryRef ? categoryBatchSalt(s.categoryRef, before.categories) : s.poRefs ? poBatchSalt(s.poRefs, before.poStates) : undefined;
  return batchKey(s.entity, s.n, s.args, s.runTag, salt) + (dry ? '-dry' : '');
}

export interface PlannedBatches { categories: Send[]; items: Send[]; purchaseOrders: Send[] }

export function planBatches(plan: MigrationPlan, opts: Pick<MigrationOptions, 'itemBatchSize' | 'poBatchSize' | 'skipBudgetCheck' | 'runTag'>): PlannedBatches {
  const itemSize = Math.min(opts.itemBatchSize ?? MAX_ITEM_BATCH, MAX_ITEM_BATCH);
  const poSize = Math.min(opts.poBatchSize ?? MAX_PO_BATCH, MAX_PO_BATCH);
  const categories = plan.categories.map((args, i): Send => ({
    entity: 'category', n: i + 1, tool: 'upsert_item_category', args, size: 1, present: () => false, runTag: opts.runTag,
    absent: (after) => (after.categories.some((c) => c.system === 'sage' && c.ref === String(args.external_ref)) ? [] : [String(args.external_ref)]),
    labelOf: () => String(args.name),
    categoryRef: String(args.external_ref), categorySent: { sageId: String(args.external_ref), name: String(args.name), isActive: args.is_active !== false },
  }));
  const items = chunk(plan.items, itemSize).map((rows, i): Send => ({
    entity: 'item', n: i + 1, tool: 'bulk_upsert_items', args: { items: rows.map((r) => r.row) }, size: rows.length,
    present: (before) => rows.every((r) => before.itemRefs.has(r.sageId)),
    absent: (after) => rows.map((r) => r.sageId).filter((id) => !after.itemRefs.has(id)), runTag: opts.runTag,
    labelOf: (id) => String(rows.find((r) => r.sageId === id)?.row.code ?? id),
    itemRows: rows.map((r) => ({ sageId: r.sageId, code: String(r.row.code) })),
    itemSent: rows.map((r) => ({ sageId: r.sageId, code: String(r.row.code), isActive: r.row.is_active !== false, itemType: String(r.row.item_type), inventoryTracked: r.row.inventory_tracked === true })),
  }));
  const purchaseOrders = chunk(plan.purchaseOrders, poSize).map((rows, i): Send => ({
    entity: 'purchase_order', n: i + 1, tool: 'bulk_create_purchase_orders', size: rows.length,
    args: { purchase_orders: rows.map((r) => r.element), ...(opts.skipBudgetCheck ? { skip_budget_check_for_import: true } : {}) },
    present: (before) => rows.every((r) => before.poTotals.has(r.sageId)),
    absent: (after) => rows.map((r) => r.sageId).filter((id) => !after.poTotals.has(id)), runTag: opts.runTag,
    labelOf: (id) => rows.find((r) => r.sageId === id)?.documentNumber ?? id,
    poRefs: rows.map((r) => r.sageId),
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
/**
 * Whether the tool's answer says it wrote nothing: an item batch with `written: false`; a PO batch that created no PO and did not raise
 * the number counter (bulk_create_purchase_orders: `created`, `counter.raised`), so a batch that re-created a deleted PO is never "nothing
 * new written" (B13-2). A category is never "present" (its flag comes from outcome unchanged alone).
 */
export function wroteNothing(entity: Send['entity'], body: Record<string, unknown> | null): boolean {
  if (entity === 'item') return body?.written !== true;
  if (entity === 'purchase_order') return body?.created === 0 && (body.counter as { raised?: unknown } | undefined)?.raised !== true;
  return true;
}

export async function sendBatch(session: ToolSession, s: Send, before: Snapshot, dry: boolean): Promise<BatchReport> {
  const key = keyFor(s, before, dry);
  const r = await session.call(s.tool, { ...s.args, idempotency_key: key });
  return {
    entity: s.entity, n: s.n, size: s.size, key, status: r.isError ? 'failed' : 'ok',
    allRowsAlreadyPresent: (s.present(before) && wroteNothing(s.entity, r.body)) || (s.entity === 'category' && r.body?.outcome === 'unchanged'), rowsAbsent: 0,
    toolReported: r.isError ? null : r.body,
    // The tool's whole message: the JSON report keeps it; only the console summary is cut.
    error: r.isError ? r.text : null,
    ...(r.replayed ? { replayed: true as const } : {}),
  };
}

/**
 * After a LIVE batch: rows it answered for that are not in the books. Which of two things happened is what the REGISTRY said, never
 * inferred from the absent rows:
 *   - it served a STORED answer (`replayed`: an earlier run's rows since deleted): nothing was written, failed with the remedy (--run-tag);
 *   - the tool RAN and committed, and another writer removed rows since: what it wrote was written; failed (the next phase must not build
 *     on it) as `changedAfterCommit`, the absent rows named in `changedRows`.
 * Returns the batch as reported.
 */
export function checkRowsPresent(b: BatchReport, s: Send, after: Snapshot): BatchReport {
  if (b.status !== 'ok') return b;
  const missing = s.absent(after);
  const absent = missing.length;
  if (absent === 0) return b;
  if (!b.replayed) {
    const names = missing.map(s.labelOf);
    return {
      ...b, status: 'failed', rowsAbsent: absent, changedAfterCommit: true, changedRows: [...(b.changedRows ?? []), ...names],
      error: `committed, but ${absent} of ${b.size} rows of this batch are not in the books now (another writer removed them since): ${names.slice(0, 10).join(', ')}. `
        + 'What the batch wrote was written; the next phase is not started. Check the books, then run again.',
    };
  }
  return {
    ...b, status: 'failed', rowsAbsent: absent,
    error: `replayed, rows absent: ${absent} of ${b.size} rows of this batch are not in the books, although the tool answered. If an earlier run of this file `
      + `imported them and they were deleted since, the batch's key (${b.key}) still holds that run's answer and replays it, writing nothing. `
      + 'Restore the rows, or run again with --run-tag <text> for a deliberate fresh import under new keys.',
  };
}
