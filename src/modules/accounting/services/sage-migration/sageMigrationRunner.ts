/**
 * The Sage migration runner (Phase D): one company, one export, categories -> items -> purchase orders.
 *
 *   1. Parse the export and resolve each PO's supplier (read tools); refuse what no tool could take (sageMigrationPlan).
 *   2. DRY RUN, always: one request transaction that is rolled back. Categories, items and purchase orders are all written LIVE
 *      inside it (the items' preview needs the categories; PO batch k's budget check needs the POs of batches 1..k-1, as the live run's
 *      has; the same code runs as live). Nothing it did survives, idempotency and audit rows included. A batch a tool refuses (a
 *      budget block among them) makes the dry run not clean and the run stops there.
 *   3. LIVE (opts.live and a clean dry run): each category, then each item batch (<= 500), then each PO batch (<= 100) is ONE
 *      committed request through the real registry, under a key derived from its rows (an item or category batch: and from the state of
 *      the owned rows it touches, so a re-run after a change in IsaFlow is a fresh call, not a replay). A PO batch replays; the others
 *      answer `unchanged`. A run that stopped at batch k resumes by running again. A failed batch is reported with the tool's message and
 *      nothing of it is written; the other batches of its phase still run, and the next phase does not start.
 *   4. The reconciliation is measured in the database before and after, not taken from what the tools said.
 */
import type { Pool } from 'pg';
import { log } from '@/lib/logger';
import type { ParsedExport } from './sageExportTypes';
import type { BatchReport, MigrationOptions, MigrationReport, PhaseReport } from './sageMigrationTypes';
import { RUN_TAG } from './sageBatches';
import { assertPoGlAccount } from './sageAccountCheck';
import { checkRowsPresent, keyFor, planBatches, sendBatch, type PlannedBatches, type Send } from './sageBatchRun';
import { categoriesMismatch, itemsMismatch, ownershipProblem } from './sageOwnership';
import { MigrationStopped } from './sageMigrationStopped';
import { budgetWouldHaveFailed } from './sageBudgetReport';
import { differencesFrom } from './sageDifferences';
import { buildLineLinks } from './sageLineLinks';
import { assertLocalDatabase, assertLocalPool } from './localGuard';
import { planMigration } from './sageMigrationPlan';
import { buildReconciliation } from './sageReconciliation';
import { readSnapshot, type Snapshot } from './sageSnapshot';
import { resolveSuppliers } from './sageSuppliers';
import { withToolSession, type ToolSession } from './sageToolSession';

const emptyPhase = (): PhaseReport => ({ batches: [], failed: 0 });

/** Why a live run must not start on this (clean) dry run; empty when it may. */
function liveBlockers(rec: MigrationReport['reconciliation'], diff: MigrationReport['differences'], o: MigrationOptions): string[] {
  const why: string[] = [];
  const names: Record<string, string> = { items: '--expect-items', purchaseOrders: '--expect-pos', purchaseOrderTotalCents: '--expect-po-total' };
  for (const [key, e] of Object.entries(rec.expected)) {
    if (e && !e.ok) why.push(`${names[key] ?? key} ${e.expected}, but the dry run would send ${e.actual}`);
  }
  if (!rec.nothingRefused && !o.allowRefusals) why.push('rows are refused (see the refused list); --allow-refusals imports the rest');
  const differs = diff.purchaseOrders.length + diff.items.length + diff.categories.length;
  if (differs > 0 && !o.allowDifferences) why.push(`${differs} PO(s), owned item(s) or owned categories differ from the books (see the differences list); --allow-differences goes on anyway`);
  return why;
}

async function dryRun(pool: Pool, o: MigrationOptions, all: PlannedBatches, before: Snapshot) {
  return withToolSession(pool, o.companyId, o.userId, false, async (session) => {
    const run = async (list: Send[]): Promise<PhaseReport> => {
      const p = emptyPhase();
      for (const s of list) {
        let b = await sendBatch(session, s, before, true);
        // The dry run's item outcomes say what the live call would do: they must agree with what the plan was made from.
        const problem = b.status === 'ok' && s.itemRows ? ownershipProblem(b, s.itemRows, before) : null;
        if (problem) b = { ...b, status: 'failed', error: problem };
        p.batches.push(b);
        if (b.status === 'failed') p.failed++;
      }
      return p;
    };
    // The phases go in the order the live run's do, and a phase does not start behind a failed one (its refusals would only be a cascade).
    const categories = await run(all.categories);
    const items = categories.failed === 0 ? await run(all.items) : emptyPhase();
    const purchaseOrders = categories.failed + items.failed === 0 ? await run(all.purchaseOrders) : emptyPhase();
    return { categories, items, purchaseOrders, clean: categories.failed + items.failed + purchaseOrders.failed === 0 };
  });
}

async function livePhase(pool: Pool, o: MigrationOptions, list: Send[], before: Snapshot, committed: BatchReport[]): Promise<PhaseReport> {
  const p = emptyPhase();
  for (const s of list) {
    let b: BatchReport;
    try {
      b = await withToolSession(pool, o.companyId, o.userId, true, (session) => sendBatch(session, s, before, false));
    } catch (err) {
      // The request transaction failed as a whole (a lost connection, a failed COMMIT): the batch is reported failed. A COMMIT whose answer
      // never came may still have landed, so the books are the judge: the run's final reconciliation reads them, and a re-run finds what landed.
      const message = err instanceof Error ? err.message : String(err);
      log.error('sage migration: batch failed', { entity: s.entity, n: s.n, message }, 'sage-migration');
      b = { entity: s.entity, n: s.n, size: s.size, key: keyFor(s, before, false), status: 'failed', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, error: message };
    }
    p.batches.push(b);
    if (b.status === 'failed') p.failed++;
    else committed.push(b); // what an error later in the run can still say was committed
  }
  return p;
}

export async function runSageMigration(pool: Pool, parsed: ParsedExport, opts: MigrationOptions): Promise<MigrationReport> {
  // The runner guards itself, not only its CLI: whoever calls it, it touches a local throwaway database or nothing.
  assertLocalDatabase();
  assertLocalPool(pool);
  if (opts.runTag !== undefined && !RUN_TAG.test(opts.runTag)) throw new Error('runTag must be 1-32 letters, digits, - or _');
  const { before, plan } = await withToolSession(pool, opts.companyId, opts.userId, false, async (session) => {
    if (opts.poGlAccountId) await assertPoGlAccount(opts.companyId, opts.poGlAccountId);
    const snapshot = await readSnapshot(opts.companyId);
    const resolved = await resolveSuppliers(session, parsed.purchaseOrders, snapshot.supplierSageRefs);
    return { before: snapshot, plan: planMigration(parsed, resolved, snapshot, { poGlAccountId: opts.poGlAccountId, skipBudgetCheck: opts.skipBudgetCheck }) };
  });
  const all = planBatches(plan, opts);
  const dry = await dryRun(pool, opts, all, before);
  const base = { companyId: opts.companyId, refused: plan.refusals, dryRun: dry };
  const skipped = (phase: PhaseReport) => (opts.skipBudgetCheck ? budgetWouldHaveFailed(phase.batches) : []);
  const dryDifferences = differencesFrom([...dry.categories.batches, ...dry.items.batches, ...dry.purchaseOrders.batches]);
  const dryReconciliation = buildReconciliation({ parsed, plan, before, after: before, failedBatches: dry.clean ? 0 : 1, expect: opts.expect, live: false });
  const noLive = (status: MigrationReport['status'], liveBlockedBy: string[] = []): MigrationReport => ({
    ...base, status, liveBlockedBy, live: null, lineLinks: buildLineLinks(plan, before, null), budgetWouldHaveFailed: skipped(dry.purchaseOrders), differences: dryDifferences, reconciliation: dryReconciliation,
  });
  if (!dry.clean) return noLive('dry_run_failed');
  if (!opts.live) return noLive('dry_run_ok');
  // Live starts only on a dry run whose result the person would accept: what would be sent matches --expect-*, and no refusal or
  // difference is there that they did not allow. Otherwise a live run would commit and then exit 1.
  const blockers = liveBlockers(dryReconciliation, dryDifferences, opts);
  if (blockers.length > 0) return noLive('live_blocked', blockers);

  // From here the live phase has STARTED: an error carries what was committed, and says the run may have committed.
  const committed: BatchReport[] = [];
  try {
    const readAfter = () => withToolSession(pool, opts.companyId, opts.userId, false, () => readSnapshot(opts.companyId));
    // A batch the tool answered whose rows are not in the books is a replayed answer of rows since deleted: failed, with the remedy. It is
    // checked BETWEEN the phases, so the next phase does not start behind absent rows (an item batch replayed "ok" with its rows gone would
    // otherwise fail every PO naming those items, a misleading cascade).
    const verified = (phase: PhaseReport, sends: Send[], snapshot: Snapshot): PhaseReport => {
      const batches = phase.batches.map((b) => checkRowsPresent(b, sends.find((x) => x.n === b.n)!, snapshot));
      return { batches, failed: batches.filter((b) => b.status === 'failed').length };
    };
    // After the items phase the books must also hold what was SENT (code, active flag, type, tracking): the PO phase names these items, and
    // a batch answered "ok" that left them otherwise (an answer replayed from an earlier run, a writer in between) must not be built on.
    const verifiedItems = async (phase: PhaseReport, snapshot: Snapshot): Promise<PhaseReport> => {
      const present = verified(phase, all.items, snapshot);
      const batches = present.batches.map((b) => {
        const send = all.items.find((x) => x.n === b.n);
        const wrong = b.status === 'ok' && send?.itemSent ? itemsMismatch(send.itemSent, snapshot) : [];
        return wrong.length === 0 ? b : { ...b, status: 'failed' as const, error: `the items in the books are not what this batch sent (${wrong.length}): ${wrong.slice(0, 5).join(' | ')}. The PO phase is not started. Run again.` };
      });
      return { batches, failed: batches.filter((b) => b.status === 'failed').length };
    };
    // The same for the categories: renamed or deactivated right after its batch committed, the items would fail on a category that is gone.
    const verifiedCategories = (phase: PhaseReport, snapshot: Snapshot): PhaseReport => {
      const batches = verified(phase, all.categories, snapshot).batches.map((b) => {
        const send = all.categories.find((x) => x.n === b.n);
        const wrong = b.status === 'ok' && send?.categorySent ? categoriesMismatch([send.categorySent], snapshot) : [];
        return wrong.length === 0 ? b : { ...b, status: 'failed' as const, error: `the category in the books is not what this batch sent: ${wrong.join(' | ')}. The items phase is not started. Run again.` };
      });
      return { batches, failed: batches.filter((b) => b.status === 'failed').length };
    };
    const liveCategories = await livePhase(pool, opts, all.categories, before, committed);
    const categoriesVerified = liveCategories.failed === 0 ? verifiedCategories(liveCategories, await readAfter()) : liveCategories;
    const liveItems = categoriesVerified.failed === 0 ? await livePhase(pool, opts, all.items, before, committed) : emptyPhase();
    const items = categoriesVerified.failed === 0 && liveItems.failed === 0 ? await verifiedItems(liveItems, await readAfter()) : liveItems;
    const livePos = categoriesVerified.failed + items.failed === 0 ? await livePhase(pool, opts, all.purchaseOrders, before, committed) : emptyPhase();
    const after = await readAfter();
    const purchaseOrders = verified(livePos, all.purchaseOrders, after);
    const failed = categoriesVerified.failed + items.failed + purchaseOrders.failed;
    const phaseSkipped = categoriesVerified.failed > 0 || items.failed > 0;
    return {
      ...base, status: failed > 0 ? 'failed' : 'completed', liveBlockedBy: [], live: { categories: categoriesVerified, items, purchaseOrders }, lineLinks: buildLineLinks(plan, before, after),
      budgetWouldHaveFailed: skipped(purchaseOrders.batches.length > 0 ? purchaseOrders : dry.purchaseOrders),
      // The dry run's findings count too: a live item batch that wrote nothing must not hide a change the dry run named.
      differences: differencesFrom([...dry.categories.batches, ...dry.items.batches, ...dry.purchaseOrders.batches, ...categoriesVerified.batches, ...items.batches, ...purchaseOrders.batches]),
      reconciliation: buildReconciliation({ parsed, plan, before, after, failedBatches: failed + (phaseSkipped ? 1 : 0), expect: opts.expect, live: true }),
    };
  } catch (err) {
    throw new MigrationStopped(err, true, committed);
  }
}
