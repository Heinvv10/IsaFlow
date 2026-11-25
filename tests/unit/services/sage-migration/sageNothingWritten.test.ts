/**
 * Round-14 breaker B14-2 and B14-4: a batch that wrote nothing (its rows were all there) stays "nothing new written" when a row of it
 * changes or goes after its COMMIT, in its error (the summary's FAILED line) and in a stop; "the next phase" is said only where there is
 * one; and the stop report lists the batches by what they did, so `committed` holds only batches that wrote.
 */
import { describe, expect, it } from 'vitest';
import { checkRowsPresent, type Send } from '@/modules/accounting/services/sage-migration/sageBatchRun';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { batchOutcome, stopMessage, stopReportBatches } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
import type { Snapshot } from '@/modules/accounting/services/sage-migration/sageSnapshot';

const b = (entity: BatchReport['entity'], n: number, over: Partial<BatchReport> = {}): BatchReport =>
  ({ entity, n, size: 2, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: { created: 0 }, error: null, ...over });
const poSend: Send = { entity: 'purchase_order', n: 1, tool: 'bulk_create_purchase_orders', args: {}, size: 2, present: () => true, labelOf: (id) => `PO-${id}`,
  absent: (after) => ['1', '2'].filter((id) => !after.poTotals.has(id)) };
const itemSend: Send = { entity: 'item', n: 1, tool: 'bulk_upsert_items', args: {}, size: 2, present: () => true, labelOf: (id) => `FIB-${id}`,
  absent: (after) => ['1', '2'].filter((id) => !after.itemRefs.has(id)) };
const books = (pos: string[], items: string[] = []) => ({ poTotals: new Map(pos.map((p) => [p, 1])), itemRefs: new Set(items) }) as unknown as Snapshot;

describe('checkRowsPresent: the error of a batch whose rows went after its COMMIT', () => {
  it('a PO batch that wrote nothing: "answered ok, nothing new written", no "What the batch wrote", no "next phase"', () => {
    const r = checkRowsPresent(b('purchase_order', 1, { allRowsAlreadyPresent: true }), poSend, books(['2']));
    expect(r).toMatchObject({ status: 'failed', changedAfterCommit: true, changedRows: ['PO-1'] });
    expect(r.error).toMatch(/^answered ok, nothing new written \(its rows were already there\), but 1 of 2 rows/);
    expect(r.error).not.toMatch(/What the batch wrote was written|next phase/);
    expect(r.error).toMatch(/: PO-1\. Check the books, then run again\.$/);
  });
  it('a PO batch that wrote: "committed ... What the batch wrote was written", still no "next phase" (there is none after the POs)', () => {
    const r = checkRowsPresent(b('purchase_order', 1), poSend, books(['2']));
    expect(r.error).toMatch(/^committed, but 1 of 2 rows .*What the batch wrote was written; check the books/);
    expect(r.error).not.toMatch(/next phase/);
  });
  it('an item batch that wrote: the next phase is not started', () => {
    expect(checkRowsPresent(b('item', 1), itemSend, books([], ['2'])).error).toMatch(/What the batch wrote was written; the next phase is not started; check the books/);
  });
});

describe('stopMessage and the stop report of a batch that wrote nothing, then changed', () => {
  const nothing = b('purchase_order', 1, { allRowsAlreadyPresent: true, status: 'failed', changedAfterCommit: true, changedRows: ['PO-1'], rowsAbsent: 1 });
  const wrote = b('item', 1, { toolReported: { rows: [{ code: 'FIB-1', outcome: 'updated', changed: ['description'] }] } });
  const lost = b('purchase_order', 2, { status: 'failed', commitUnconfirmed: true, toolReported: null });
  const refused = b('item', 2, { status: 'failed', commitUnconfirmed: true, toolRefused: true, toolReported: null, error: 'the tool refused this batch (x)' });
  const err = new MigrationStopped(new Error('boom'), true, [wrote, nothing, lost, refused], { failed: [b('item', 3, { status: 'failed', toolReported: null, error: 'no' })], dryRun: [] });
  it('the message says it wrote nothing, then names what changed; it is never "committed"', () => {
    const m = stopMessage(err);
    expect(m).toContain('answered ok, nothing new written (its rows were already there): purchase_order batch 1 (k-purchase_order-1) (then changed or removed in the books by another writer: PO-1: check)');
    expect(m).not.toMatch(/committed: purchase_order batch 1/);
    expect(m).toMatch(/\ncommitted: item batch 1 \(k-item-1\)\n {2}was updated/);
  });
  it('the report lists by outcome: committed only what wrote; nothing written; unconfirmed (a refusal among them); failed', () => {
    const r = stopReportBatches(err);
    expect(r.committed.map((x) => `${x.entity} ${x.n}`)).toEqual(['item 1']);
    expect(r.nothingWritten.map((x) => `${x.entity} ${x.n}`)).toEqual(['purchase_order 1']);
    expect(r.commitUnconfirmed.map((x) => `${x.entity} ${x.n}`)).toEqual(['purchase_order 2', 'item 2']);
    expect(r.failed.map((x) => `${x.entity} ${x.n}`)).toEqual(['item 3']);
    expect([wrote, nothing, lost, refused, b('item', 4, { replayed: true })].map(batchOutcome)).toEqual(['committed', 'nothing_written', 'commit_unconfirmed', 'commit_unconfirmed', 'replayed']);
  });
});

describe('R15-L2 (round 15): a replayed batch in the stop report', () => {
  it('is listed under nothingWritten (no tool ran), also when its COMMIT is unconfirmed; never under committed', () => {
    const replayed = b('item', 1, { replayed: true });
    const replayedLost = b('item', 2, { replayed: true, status: 'failed', commitUnconfirmed: true });
    const r = stopReportBatches(new MigrationStopped(new Error('x'), true, [replayed, replayedLost], { failed: [], dryRun: [] }));
    expect(r.nothingWritten.map((x) => x.n)).toEqual([1, 2]);
    expect([r.committed, r.commitUnconfirmed]).toEqual([[], []]);
  });
});
