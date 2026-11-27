/**
 * The Sage migration runner (Phase D): one company, one export, categories -> items -> purchase orders.
 *
 *   1. Parse the export and resolve each PO's supplier (read tools); refuse what no tool could take (sageMigrationPlan).
 *   2. DRY RUN, always: one request transaction that is rolled back. Categories, items and purchase orders are all written LIVE
 *      inside it (the items' preview needs the categories; PO batch k's budget check needs the POs of batches 1..k-1, as the live run's
 *      has; the same code runs as live). Nothing it did survives, idempotency and audit rows included. A batch a tool refuses (a
 *      budget block among them) makes the dry run not clean and the run stops there.
 *   3. LIVE (opts.live and a clean dry run): each category, then each item batch (<= 500), then each PO batch (<= 100) is ONE
 *      committed request through the real registry, under a key derived from its rows and salted with a hash of the state of the existing
 *      rows the batch touches (category, item and PO batches alike), so a re-run after a change in IsaFlow is a fresh call, not a replay of
 *      a stored answer; the batches whose rows are unchanged answer `unchanged` / already there. A run that stopped at batch k resumes by running again. A failed batch is reported with the tool's message and
 *      nothing of it is written; the other batches of its phase still run, and the next phase does not start. A batch whose COMMIT did not
 *      answer (it may still land) stops the run there: MigrationStopped, exit 4.
 *   4. The reconciliation is measured in the database before and after, not taken from what the tools said.
 */
import type { Pool } from 'pg';
import { formatCents } from '@/lib/money/formatMoney';
import { log } from '@/lib/logger';
import type { ParsedExport } from './sageExportTypes';
import type { BatchReport, MigrationOptions, MigrationReport, PhaseReport } from './sageMigrationTypes';
import { RUN_TAG } from './sageBatches';
import { assertPoGlAccount } from './sageAccountCheck';
import { keyFor, planBatches, sendBatch, type PlannedBatches, type Send } from './sageBatchRun';
import { ownershipProblem } from './sageOwnership';
import { recordSent, settleCommitted, stoppedBatches, unconfirmedBatch, verified, verifiedCategories, verifiedItems, type Sent } from './sageVerify';
import { MigrationStopped } from './sageMigrationStopped';
import { BatchKeyHeldError, CommitRefusedError, CommitUnconfirmedError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError, RunEndedError, StatementTimeoutError } from './sageToolSession';
import { causeWording } from './sageSessionErrors';
import { budgetWouldHaveFailed } from './sageBudgetReport';
import { differencesFrom } from './sageDifferences';
import { buildLineLinks } from './sageLineLinks';
import { acquireRunLock, type RunLock } from './sageRunLock';
import { assertLocalDatabase, assertLocalPool } from './localGuard';
import { planMigration } from './sageMigrationPlan';
import { poContentDifferences, withContentDifferences } from './sagePoContent';
import { buildReconciliation } from './sageReconciliation';
import { readSnapshot, type Snapshot } from './sageSnapshot';
import { resolveSuppliers } from './sageSuppliers';
import { withToolSession } from './sageToolSession';
import { safeThrown, told } from './sageTold';

/** The caller asked the run to stop (a signal): thrown where the run lock is checked, so the usual stop path reports it. */
export class StopRequested extends Error {}

const emptyPhase = (): PhaseReport => ({ batches: [], failed: 0 });
/** A phase that never started because an earlier one failed. */
const skippedPhase = (): PhaseReport => ({ batches: [], failed: 0, skipped: true });

/** Why a live run must not start on this (clean) dry run; empty when it may. */
function liveBlockers(rec: MigrationReport['reconciliation'], diff: MigrationReport['differences'], o: MigrationOptions): string[] {
  const why: string[] = [];
  const names: Record<string, string> = { items: '--expect-items', purchaseOrders: '--expect-pos', purchaseOrderTotalCents: '--expect-po-total' };
  for (const [key, e] of Object.entries(rec.expected)) {
    if (e && !e.ok) {
      const fig = (n: number): string => (key === 'purchaseOrderTotalCents' ? formatCents(n) : String(n));
      why.push(`${names[key] ?? key} ${fig(e.expected)}, but the dry run would ${e.basis === 'projected' ? 'leave the books at' : 'send'} ${fig(e.actual)}`);
    }
  }
  if (!rec.nothingRefused && !o.allowRefusals) why.push('rows are refused (see the refused list); --allow-refusals imports the rest');
  const differs = diff.purchaseOrders.length + diff.items.length + diff.categories.length;
  if (differs > 0 && !o.allowDifferences) why.push(`${differs} PO(s), owned item(s) or owned categories differ from the books (see the differences list); --allow-differences goes on anyway`);
  return why;
}

/** A dry batch that waited on another session's lock (a held key, a lock timeout): the dry run stops at it (round 25). */
export interface DryLockStop { batch: BatchReport; error: Error }

/** What every session of the run is given: the notices, and when the run lock was taken (R28-4). */
const sessionOpts = (o: MigrationOptions) => ({ onNotice: o.onNotice, runLockAt: o.runLockAt, ended: o.ended });

async function dryRun(pool: Pool, o: MigrationOptions, all: PlannedBatches, before: Snapshot) {
  return withToolSession(pool, o.companyId, o.userId, false, async (session) => {
    let lockStop: DryLockStop | null = null;
    const run = async (list: Send[]): Promise<PhaseReport> => {
      const p = emptyPhase();
      for (const s of list) {
        // A stop asked for in the dry run (round 18, B18-3): thrown inside its transaction, so it rolls back: a refused start, nothing written.
        const stop = o.shouldStop?.();
        if (stop) throw new StopRequested(stop);
        let b: BatchReport;
        let waited: Error | null = null;
        try { b = await sendBatch(session, s, before, true); } catch (err) {
          // A held key, or a stall that made the call itself reject (the registry's bookkeeping, R27-1): this batch, and the dry run stops.
          if (!(err instanceof BatchKeyHeldError || err instanceof LockWaitError || err instanceof StatementTimeoutError)) throw err;
          [waited, b] = [err, { entity: s.entity, n: s.n, size: s.size, key: keyFor(s, before, true), status: 'failed', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, error: err.message }];
        }
        // A lock wait (55P03) or a statement (57014) that timed out inside the tool: its generic failure is replaced by what it was.
        waited ??= session.stall?.() ?? null;
        if (waited !== null) b = { ...b, status: 'failed', error: waited.message };
        // The dry run's item outcomes say what the live call would do: they must agree with what the plan was made from.
        const problem = b.status === 'ok' && s.itemRows ? ownershipProblem(b, s.itemRows, before) : null;
        if (problem) b = { ...b, status: 'failed', error: problem };
        p.batches.push(b);
        if (b.status === 'failed') p.failed++;
        o.onProgress?.({ kind: 'recorded', phase: 'dry', batch: b });
        // The FIRST lock wait stops the dry run (B25-1): every later batch would queue on the same holder for its own lock timeout.
        if (waited !== null) { lockStop = { batch: b, error: waited }; break; }
      }
      return p;
    };
    o.onProgress?.({ kind: 'phase', phase: 'dry' });
    // The phases go in the order the live run's do, and a phase does not start behind a failed one (its refusals would only be a cascade).
    const categories = await run(all.categories);
    const items = categories.failed === 0 ? await run(all.items) : skippedPhase();
    const purchaseOrders = categories.failed + items.failed === 0 ? await run(all.purchaseOrders) : skippedPhase();
    return { categories, items, purchaseOrders, clean: categories.failed + items.failed + purchaseOrders.failed === 0, lockStop: lockStop as DryLockStop | null };
  }, { wrote: true, ...sessionOpts(o) }); // the dry run WRITES (rolled back): its ROLLBACK must be confirmed (R23-5)
}

async function livePhase(pool: Pool, o: MigrationOptions, list: Send[], before: Snapshot, sent: Sent, beforeBatch: () => Promise<void>): Promise<PhaseReport> {
  const p = emptyPhase();
  for (const s of list) {
    // The lock is asked before EVERY batch (one SELECT 1, bounded by CHECK_TIMEOUT_MS, and the connection's own error flag): a loss it
    // already knows of stops the run here; a half-open connection is noticed within the timeout, so at most one batch can be in flight
    // beyond the loss. Thrown outside the batch's own try, so it stops the run, listing what was committed. A stop asked for, too.
    await beforeBatch();
    let b: BatchReport;
    let stopHere = false;
    o.onProgress?.({ kind: 'sending', batch: { entity: s.entity, n: s.n, size: s.size, key: keyFor(s, before, false) } });
    try {
      b = await withToolSession(pool, o.companyId, o.userId, true, (session) => sendBatch(session, s, before, false), sessionOpts(o));
    } catch (raw) {
      const err = safeThrown(raw); // B36-1: no read below can throw
      // The request transaction failed as a whole (a lost connection, a failed COMMIT): the batch is reported failed. A COMMIT whose answer
      // never came may still have landed, so the books are the judge: the run stops (below) and a re-run finds what landed.
      const message = told(err);
      log.error('sage migration: batch failed', { entity: s.entity, n: s.n, message }, 'sage-migration');
      b = { entity: s.entity, n: s.n, size: s.size, key: keyFor(s, before, false), status: 'failed', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, error: message };
      // An unconfirmed COMMIT may have landed: keep the LIVE tool answer the request had before its COMMIT (what the batch did if it landed).
      if (err instanceof CommitUnconfirmedError) b = unconfirmedBatch(b, err.result as BatchReport | undefined, err.connectionLost);
      // Lost before its COMMIT was sent, its key held by another session, or a lock wait that timed out (R25-3): failed, nothing written;
      // the run still stops here (below): the connection went away, or every later batch would queue on the same holder.
      // A COMMIT the server refused (B28-2) is failed, nothing written, too; the run stops: its cause (a cancel, a constraint) would recur.
      if (err instanceof LostBeforeCommitError || err instanceof BatchKeyHeldError || err instanceof LockWaitError || err instanceof StatementTimeoutError || err instanceof CommitRefusedError || err instanceof RunEndedError) stopHere = true;
    }
    p.batches.push(b);
    if (b.status === 'failed') p.failed++;
    // What an error later in the run can still say was (or may have been) committed, and what failed before it with its reason.
    recordSent(sent, b);
    o.onProgress?.({ kind: 'recorded', phase: 'live', batch: b });
    // A COMMIT that did not answer may still land: the next batch would be checked (its budget, the rows it builds on) against books that
    // may not hold it yet. The run stops here, in any phase (MigrationStopped, exit 4), the batch listed as "commit unconfirmed".
    if (b.commitUnconfirmed) {
      throw new Error(`the COMMIT of ${b.entity} batch ${b.n} (${b.key}) did not answer (${b.error ?? 'no detail'}): it may still land, so no further batch is sent. Check the books; a re-run resumes`);
    }
    if (stopHere) throw new Error(`${b.entity} batch ${b.n} (${b.key}) failed: ${b.error}; no further batch is sent, a re-run resumes`);
  }
  return p;
}

/**
 * What a stop reports as committed, checked against the books as the phases are (settleCommitted). Best effort: if the books cannot be
 * read, the batches are listed as they were, and the stop says they were not re-checked (`unchecked`, said in the stop message).
 */
async function settled(committed: BatchReport[], all: PlannedBatches, read: () => Promise<Snapshot>): Promise<{ committed: BatchReport[]; unchecked?: string }> {
  let snapshot: Snapshot;
  try { snapshot = await read(); } catch (raw) {
    const err = safeThrown(raw);
    const message = told(err);
    // The caller ended the run (R29-1): nothing is read, and nothing is said of it here (the caller's own stop report stands).
    if (!(err instanceof RunEndedError)) log.warn('sage migration: the books could not be read to check the committed batches', { message }, 'sage-migration');
    // Only why the READ failed: never the read's own "nothing of it was written", which would read as said of the batches (B28-6, R29-6).
    return { committed, unchecked: causeWording(err) };
  }
  return { committed: settleCommitted(committed, all, snapshot) };
}

export async function runSageMigration(pool: Pool, parsed: ParsedExport, opts: MigrationOptions): Promise<MigrationReport> {
  // The runner guards itself, not only its CLI: whoever calls it, it touches a local throwaway database or nothing, and one run per company.
  assertLocalDatabase();
  assertLocalPool(pool);
  // A live run commits: the runner itself, not only its CLI, refuses to go live without the two counts the person expects to check against.
  if (opts.live && opts.liveWithoutCounts !== true && (opts.expect?.items === undefined || opts.expect?.purchaseOrders === undefined)) {
    throw new Error('a live run needs expect.items and expect.purchaseOrders (the counts the person expects to be sent): without them nothing says the export is the whole one (liveWithoutCounts: true is the explicit opt-out)');
  }
  // The run lock holds one connection for the whole run and every tool session needs another: with one in all, the run would wait forever.
  if ((pool.options?.max ?? 10) < 2) throw new Error('the Sage migration needs a pool of at least 2 connections (the run lock holds one for the whole run)');
  const lock = await acquireRunLock(pool, opts.companyId, opts.onNotice); // watched: a connect with no answer is said (R27-6)
  let report: MigrationReport;
  try {
    report = await runLocked(pool, parsed, { ...opts, runLockAt: Date.now() }, lock); // when the lock was taken: told to every session
  } catch (err) {
    const unconfirmed = await lock.unlock(); // B25-3: said even when the run itself stopped
    if (unconfirmed) opts.onNotice?.(`WARNING: ${unconfirmed}`);
    throw err;
  }
  const unconfirmed = await lock.unlock();
  return unconfirmed ? { ...report, runLockUnconfirmed: unconfirmed } : report;
}

async function runLocked(pool: Pool, parsed: ParsedExport, opts: MigrationOptions, lock: RunLock): Promise<MigrationReport> {
  // Before every live batch (and before the live phase), a stop the caller asked for (opts.shouldStop: the CLI's signals) is checked with
  // the lock. Asked AFTER the lock's round trip: a signal is handled on an event-loop turn, and the round trip is one, so a signal that came
  // while the previous batch committed is seen here, before the next batch. Between the phases and after the last batch only the lock is
  // checked: no batch follows a stop there anyway, and a finished run keeps its reconciliation (R18-6).
  const beforeBatch = async (): Promise<void> => {
    await lock.check();
    const stop = opts.shouldStop?.();
    if (stop) throw new StopRequested(stop);
  };
  if (opts.runTag !== undefined && !RUN_TAG.test(opts.runTag)) throw new Error('runTag must be 1-32 letters, digits, - or _');
  const notice = sessionOpts(opts);
  const { before, plan } = await withToolSession(pool, opts.companyId, opts.userId, false, async (session) => {
    if (opts.poGlAccountId) await assertPoGlAccount(opts.companyId, opts.poGlAccountId);
    const snapshot = await readSnapshot(opts.companyId);
    const resolved = await resolveSuppliers(session, parsed.purchaseOrders, snapshot.supplierSageRefs);
    return { before: snapshot, plan: planMigration(parsed, resolved, snapshot, { poGlAccountId: opts.poGlAccountId, skipBudgetCheck: opts.skipBudgetCheck }) };
  }, notice);
  const all = planBatches(plan, opts);
  // B24-1: a dry run whose ROLLBACK is not confirmed keeps its result where no live run follows (a preview, a failed or blocked dry run),
  // with the warning that its writes may still be held; only a run that would go live refuses (below, before the live phase).
  let held: DryRollbackUnconfirmedError | null = null;
  let dryOut: Awaited<ReturnType<typeof dryRun>>;
  try {
    dryOut = await dryRun(pool, opts, all, before);
  } catch (err) {
    // Kept only with a result the dry run finished with: one that ended on its own error (`after`, R24-5) or before any result is thrown.
    if (!(err instanceof DryRollbackUnconfirmedError) || err.result === undefined || err.after !== undefined) throw err;
    held = err;
    dryOut = err.result as Awaited<ReturnType<typeof dryRun>>;
  }
  const { lockStop, ...dry } = dryOut;
  // The dry run stopped on another session's lock (round 25): a --live run refuses its start (exit 2); a preview reports dry_run_failed.
  if (lockStop && opts.live) throw new Error(`the dry run stopped at ${lockStop.batch.entity} batch ${lockStop.batch.n} (${lockStop.batch.key}): ${told(lockStop.error)}; the live run was not started${held ? `; ${held.held}` : ''}`); // R26-6
  const base = { companyId: opts.companyId, refused: plan.refusals, dryRun: dry, ...(held ? { dryRunHeld: held.held } : {}) };
  const skipped = (phase: PhaseReport) => (opts.skipBudgetCheck ? budgetWouldHaveFailed(phase.batches) : []);
  // What the PO tool does not compare (supplier, delivery date, reference, lines) is compared here, from the books as read before the run.
  const contentDifferences = poContentDifferences(plan, before.poContent);
  const dryDifferences = withContentDifferences(differencesFrom([...dry.categories.batches, ...dry.items.batches, ...dry.purchaseOrders.batches]), contentDifferences);
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
  if (held) throw held; // the live run would start behind the dry run's held writes: a refused start (exit 2, R23-5)

  // The lock's connection sat idle through the dry run: if its backend was dropped, another run could start now, so this one stops. Checked
  // BEFORE the live phase counts as started: a refused start, nothing written (then between the phases, below). A stop asked for, too.
  await beforeBatch();
  // From here the live phase has STARTED: an error carries what was committed, and says the run may have committed.
  const sent: Sent = { committed: [], failed: [] };
  opts.onProgress?.({ kind: 'phase', phase: 'live' });
  try {
    const readAfter = () => withToolSession(pool, opts.companyId, opts.userId, false, () => readSnapshot(opts.companyId), notice);
    // Every phase is checked against the books BETWEEN the phases (sageVerify), so the next phase does not start behind absent rows or rows
    // other than what was sent (an item batch with its rows gone would otherwise fail every PO naming those items, a misleading cascade).
    const liveCategories = await livePhase(pool, opts, all.categories, before, sent, beforeBatch);
    // Every phase's batches are checked against the books, a failed sibling or not: a replay whose rows are gone must not read ok.
    const categoriesVerified = verifiedCategories(liveCategories, all.categories, await readAfter());
    await lock.check();
    const liveItems = categoriesVerified.failed === 0 ? await livePhase(pool, opts, all.items, before, sent, beforeBatch) : skippedPhase();
    const items = categoriesVerified.failed === 0 ? verifiedItems(liveItems, all.items, await readAfter()) : liveItems;
    await lock.check();
    const livePos = categoriesVerified.failed + items.failed === 0 ? await livePhase(pool, opts, all.purchaseOrders, before, sent, beforeBatch) : skippedPhase();
    await lock.check();
    const after = await readAfter();
    const purchaseOrders = livePos.skipped ? livePos : verified(livePos, all.purchaseOrders, after);
    const failed = categoriesVerified.failed + items.failed + purchaseOrders.failed;
    // The dry run's findings count too: a live item batch that wrote nothing must not hide a change the dry run named.
    const differences = withContentDifferences(differencesFrom([...dry.categories.batches, ...dry.items.batches, ...dry.purchaseOrders.batches, ...categoriesVerified.batches, ...items.batches, ...purchaseOrders.batches]), contentDifferences);
    return {
      ...base, status: failed > 0 ? 'failed' : 'completed', liveBlockedBy: [], live: { categories: categoriesVerified, items, purchaseOrders }, lineLinks: buildLineLinks(plan, before, after),
      budgetWouldHaveFailed: skipped(purchaseOrders.batches.length > 0 ? purchaseOrders : dry.purchaseOrders),
      differences,
      reconciliation: buildReconciliation({
        parsed, plan, before, after, failedBatches: failed, expect: opts.expect, live: true,
        // Only when the person allowed differences: otherwise a PO booked with another total keeps the run from being complete.
        differingRefs: opts.allowDifferences ? new Set(differences.purchaseOrders.flatMap((d) => before.poNumbers.get(d.poNumber)?.ref ?? [])) : undefined,
      }),
    };
  } catch (err) {
    const { committed, unchecked } = await settled(sent.committed, all, () => withToolSession(pool, opts.companyId, opts.userId, false, () => readSnapshot(opts.companyId), notice));
    throw new MigrationStopped(err, true, committed, { ...stoppedBatches(sent), ...(unchecked === undefined ? {} : { booksNotRechecked: unchecked }) });
  }
}
