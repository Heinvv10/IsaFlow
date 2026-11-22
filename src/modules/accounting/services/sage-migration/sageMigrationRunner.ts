/**
 * The Sage migration runner (Phase D): one company, one export, categories -> items -> purchase orders.
 *
 *   1. Parse the export and resolve each PO's supplier (read tools); refuse what no tool could take (sageMigrationPlan).
 *   2. DRY RUN, always: one request transaction that is rolled back. Categories are created inside it (so the items' dry run
 *      finds them), items and POs run with dry_run: true. Nothing it did survives. A batch a tool refuses, or a PO the live
 *      budget check would block, makes the dry run not clean and the run stops there.
 *   3. LIVE (opts.live and a clean dry run): each category, then each item batch (<= 500), then each PO batch (<= 100) is ONE
 *      committed request through the real registry, under a key derived from its rows, so a re-run replays instead of repeating
 *      and a run that stopped at batch k resumes by running again. A failed batch is reported with the tool's message and
 *      nothing of it is written; the other batches of its phase still run, and the next phase does not start.
 *   4. The reconciliation is measured in the database before and after, not taken from what the tools said.
 */
import type { Pool } from 'pg';
import { log } from '@/lib/logger';
import type { ParsedExport } from './sageExportTypes';
import type { BatchEntity, BatchReport, MigrationOptions, MigrationReport, PhaseReport } from './sageMigrationTypes';
import { MAX_ITEM_BATCH, MAX_PO_BATCH, batchKey, chunk } from './sageBatches';
import { planMigration, type MigrationPlan } from './sageMigrationPlan';
import { buildReconciliation } from './sageReconciliation';
import { readSnapshot, type Snapshot } from './sageSnapshot';
import { resolveSuppliers } from './sageSuppliers';
import { withToolSession, type ToolSession } from './sageToolSession';

const emptyPhase = (): PhaseReport => ({ batches: [], failed: 0 });

interface Send {
  entity: BatchEntity;
  n: number;
  tool: string;
  args: Record<string, unknown>;
  size: number;
  present: (before: Snapshot) => boolean;
}

/** The batches of a plan, in order: categories (one call each), item batches, PO batches. */
function sends(plan: MigrationPlan, opts: MigrationOptions): { categories: Send[]; items: Send[]; purchaseOrders: Send[] } {
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

async function sendBatch(session: ToolSession, s: Send, before: Snapshot, dry: boolean): Promise<BatchReport> {
  // A dry run's key is its own: nothing of it survives, and it must never be mistaken for the live batch's.
  const key = batchKey(s.entity, s.n, s.args) + (dry ? '-dry' : '');
  const useDryFlag = dry && s.entity !== 'category'; // a category is created inside the rolled-back dry-run transaction
  const r = await session.call(s.tool, { ...s.args, idempotency_key: key, ...(useDryFlag ? { dry_run: true } : {}) });
  const wouldFail = useDryFlag && s.entity === 'purchase_order' && r.body?.would_succeed === false;
  const failed = r.isError || wouldFail;
  const error = r.isError ? r.text.slice(0, 4000)
    : wouldFail ? `the live call would be refused: ${JSON.stringify(r.body?.budget_blocked ?? r.body).slice(0, 4000)}` : null;
  return {
    entity: s.entity, n: s.n, size: s.size, key, status: failed ? 'failed' : 'ok',
    allRowsAlreadyPresent: s.present(before) || (s.entity === 'category' && r.body?.outcome === 'unchanged'),
    toolReported: r.isError ? null : r.body, error,
  };
}

async function dryRun(pool: Pool, o: MigrationOptions, all: ReturnType<typeof sends>, before: Snapshot) {
  return withToolSession(pool, o.companyId, o.userId, false, async (session) => {
    const run = async (list: Send[]): Promise<PhaseReport> => {
      const p = emptyPhase();
      for (const s of list) { const b = await sendBatch(session, s, before, true); p.batches.push(b); if (b.status === 'failed') p.failed++; }
      return p;
    };
    const categories = await run(all.categories);
    // Items cannot be previewed without their categories; a failed category makes their refusals follow from it.
    const items = await run(all.items);
    const purchaseOrders = await run(all.purchaseOrders);
    return { categories, items, purchaseOrders, clean: categories.failed + items.failed + purchaseOrders.failed === 0 };
  });
}

async function livePhase(pool: Pool, o: MigrationOptions, list: Send[], before: Snapshot): Promise<PhaseReport> {
  const p = emptyPhase();
  for (const s of list) {
    let b: BatchReport;
    try {
      b = await withToolSession(pool, o.companyId, o.userId, true, (session) => sendBatch(session, s, before, false));
    } catch (err) {
      // The request transaction failed as a whole (a lost connection, a failed COMMIT): nothing of the batch is in the books.
      const message = err instanceof Error ? err.message : String(err);
      log.error('sage migration: batch failed', { entity: s.entity, n: s.n, message }, 'sage-migration');
      b = { entity: s.entity, n: s.n, size: s.size, key: batchKey(s.entity, s.n, s.args), status: 'failed', allRowsAlreadyPresent: false, toolReported: null, error: message };
    }
    p.batches.push(b);
    if (b.status === 'failed') p.failed++;
  }
  return p;
}

export async function runSageMigration(pool: Pool, parsed: ParsedExport, opts: MigrationOptions): Promise<MigrationReport> {
  const { before, plan } = await withToolSession(pool, opts.companyId, opts.userId, false, async (session) => {
    const resolved = await resolveSuppliers(session, parsed.purchaseOrders);
    return { before: await readSnapshot(opts.companyId), plan: planMigration(parsed, resolved) };
  });
  const all = sends(plan, opts);
  const dry = await dryRun(pool, opts, all, before);
  const base = { companyId: opts.companyId, refused: plan.refusals, dryRun: dry };
  const noLive = (status: MigrationReport['status']): MigrationReport => ({
    ...base, status, live: null, reconciliation: buildReconciliation({ parsed, plan, before, after: before, failedBatches: dry.clean ? 0 : 1, expect: opts.expect, live: false }),
  });
  if (!dry.clean) return noLive('dry_run_failed');
  if (!opts.live) return noLive('dry_run_ok');

  const categories = await livePhase(pool, opts, all.categories, before);
  const items = categories.failed === 0 ? await livePhase(pool, opts, all.items, before) : emptyPhase();
  const purchaseOrders = categories.failed + items.failed === 0 ? await livePhase(pool, opts, all.purchaseOrders, before) : emptyPhase();
  const after = await withToolSession(pool, opts.companyId, opts.userId, false, () => readSnapshot(opts.companyId));
  const failed = categories.failed + items.failed + purchaseOrders.failed;
  const skipped = categories.failed > 0 || items.failed > 0;
  return {
    ...base, status: failed > 0 ? 'failed' : 'completed', live: { categories, items, purchaseOrders },
    reconciliation: buildReconciliation({ parsed, plan, before, after, failedBatches: failed + (skipped ? 1 : 0), expect: opts.expect, live: true }),
  };
}
