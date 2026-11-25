/**
 * The checks of a live phase against the books, and what a stop is handed: PURE (the runner reads the snapshot and calls these).
 *   - every phase: rows of a batch the tool answered for that are not in the books (checkRowsPresent: a stored answer, or a write
 *     another writer removed since);
 *   - items and categories: the books hold what was SENT (code, active flag, type, tracking / name, active flag), so the next phase,
 *     which names them, is not built on rows that are otherwise. A batch the tool RAN that fails it committed what it wrote:
 *     `changedAfterCommit`, the rows named in `changedRows`. A stored answer wrote nothing and gets no such note.
 */
import type { BatchReport, PhaseReport } from './sageMigrationTypes';
import { checkRowsPresent, type PlannedBatches, type Send } from './sageBatchRun';
import type { StoppedBatches } from './sageMigrationStopped';
import { categoriesMismatch, itemsMismatchRows } from './sageOwnership';
import type { Snapshot } from './sageSnapshot';

const phaseOf = (batches: BatchReport[]): PhaseReport => ({ batches, failed: batches.filter((b) => b.status === 'failed').length });

export function verified(phase: PhaseReport, sends: readonly Send[], snapshot: Snapshot): PhaseReport {
  return phaseOf(phase.batches.map((b) => checkRowsPresent(b, sends.find((x) => x.entity === b.entity && x.n === b.n)!, snapshot)));
}

/** After the items phase: rows present, and the books hold what each batch sent. */
export function verifiedItems(phase: PhaseReport, sends: readonly Send[], snapshot: Snapshot): PhaseReport {
  return phaseOf(verified(phase, sends, snapshot).batches.map((b) => {
    const send = sends.find((x) => x.n === b.n);
    const wrong = (b.status === 'ok' || b.changedAfterCommit) && send?.itemSent ? itemsMismatchRows(send.itemSent, snapshot) : [];
    if (wrong.length === 0) return b;
    const text = `the items in the books are not what this batch sent (${wrong.length}): ${wrong.slice(0, 5).map((w) => w.text).join(' | ')}. The PO phase is not started. Run again.`;
    return { ...b, status: 'failed' as const, error: b.status === 'failed' && b.error ? `${b.error} ${text}` : text,
      ...(b.replayed ? {} : { changedAfterCommit: true as const, changedRows: [...(b.changedRows ?? []), ...wrong.map((w) => w.code)] }) };
  }));
}

/** After the categories phase: rows present, and the books hold the name and active flag each category batch sent. */
export function verifiedCategories(phase: PhaseReport, sends: readonly Send[], snapshot: Snapshot): PhaseReport {
  return phaseOf(verified(phase, sends, snapshot).batches.map((b) => {
    const sent = sends.find((x) => x.n === b.n)?.categorySent;
    const wrong = b.status === 'ok' && sent ? categoriesMismatch([sent], snapshot) : [];
    if (wrong.length === 0 || !sent) return b;
    return { ...b, status: 'failed' as const, error: `the category in the books is not what this batch sent: ${wrong.join(' | ')}. The items phase is not started. Run again.`,
      ...(b.replayed ? {} : { changedAfterCommit: true as const, changedRows: [sent.name] }) };
  }));
}

/**
 * The batch report of a live batch whose COMMIT did not answer, from what the request had before its COMMIT (`live`, the batch as sent):
 * its live answer (B12-1), or, when the tool REFUSED the batch, that refusal (round-13 L3: it wrote nothing, landed or not).
 */
export function unconfirmedBatch(failed: BatchReport, live: BatchReport | undefined): BatchReport {
  if (live?.status === 'failed' && !live.commitUnconfirmed) {
    return { ...failed, commitUnconfirmed: true, toolRefused: true, toolReported: null, error: `the tool refused this batch (${live.error ?? 'no reason given'}); its COMMIT was not confirmed (${failed.error ?? 'no detail'})` };
  }
  return { ...failed, commitUnconfirmed: true, toolReported: live?.toolReported ?? null, ...(live?.replayed ? { replayed: true as const } : {}) };
}

/**
 * What a stop calls committed, checked against the books as the live phases are (round-13 L6): rows present for every batch, and for
 * category and item batches the books hold what was sent, so a batch that fails that check is never listed as plain "committed".
 */
export function settleCommitted(committed: readonly BatchReport[], all: PlannedBatches, snapshot: Snapshot): BatchReport[] {
  return committed.map((b) => {
    const one = phaseOf([b]);
    if (b.entity === 'category') return verifiedCategories(one, all.categories, snapshot).batches[0]!;
    if (b.entity === 'item') return verifiedItems(one, all.items, snapshot).batches[0]!;
    return all.purchaseOrders.some((x) => x.n === b.n) ? verified(one, all.purchaseOrders, snapshot).batches[0]! : b;
  });
}

/** What the live phases sent so far, for a stop: the batches that committed (or may have), and those that failed (nothing written). */
export interface Sent { committed: BatchReport[]; failed: BatchReport[] }

export function recordSent(sent: Sent, b: BatchReport): void {
  if (b.status === 'ok' || b.commitUnconfirmed) sent.committed.push(b);
  else sent.failed.push(b);
}

/** The batches a stop carries: the failed ones, and the dry run's category and item batches (the fallback of an unconfirmed batch with no live answer). */
export function stoppedBatches(sent: Sent, dry: { categories: PhaseReport; items: PhaseReport }): StoppedBatches {
  return { failed: sent.failed, dryRun: [...dry.categories.batches, ...dry.items.batches] };
}
