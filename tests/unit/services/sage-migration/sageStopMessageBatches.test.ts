/**
 * Round-11 breaker B11-3 and review R3: a stop after the live phase started says, per batch, what it did to the books.
 *   - a committed batch lists the owned items / categories it put back to Sage's values (the IsaFlow edit is overwritten): the dry run the
 *     message recommends no longer shows them once they are;
 *   - a batch whose COMMIT is unconfirmed lists what it MAY have updated, from its LIVE answer only (round 22: never the dry run's);
 *   - a batch refused earlier in the run is listed "failed, nothing written" with its reason.
 */
import { describe, expect, it } from 'vitest';
import { stopMessage, stopReportBatches } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import { unconfirmedBatch } from '@/modules/accounting/services/sage-migration/sageVerify';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const base = (entity: BatchReport['entity'], n: number, over: Partial<BatchReport> = {}): BatchReport =>
  ({ entity, n, size: 1, key: `key-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, error: null, ...over });
const itemsAnswer = (...rows: Array<[string, string, string[]]>) => ({ rows: rows.map(([code, outcome, changed]) => ({ code, outcome, changed })) });
const OVERWRITTEN = "was updated to Sage's values (an IsaFlow edit of these fields was overwritten)";

describe('B11-3: the overwrites of the committed batches', () => {
  it('a committed item / category batch names the rows it updated, with the fields; created and unchanged rows are not named', () => {
    const items = base('item', 1, { toolReported: itemsAnswer(['FIB-0002', 'updated', ['description']], ['FIB-0003', 'unchanged', []], ['FIB-0099', 'created', []]) });
    const cat = base('category', 3, { toolReported: { outcome: 'updated', name: 'Tools', changed: ['name'] } });
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [cat, items]));
    expect(m).toContain(`committed: category batch 3 (key-category-3)\n  ${OVERWRITTEN}: category Tools (name)`);
    expect(m).toContain(`committed: item batch 1 (key-item-1)\n  ${OVERWRITTEN}: item FIB-0002 (description)`);
    expect(m).not.toMatch(/FIB-0003|FIB-0099/);
  });
  it('a batch that answered ok but wrote nothing, or replayed with its rows absent, names no overwrite', () => {
    const none = base('item', 1, { allRowsAlreadyPresent: true, toolReported: itemsAnswer(['FIB-0002', 'updated', ['description']]) });
    const replayed = base('item', 2, { status: 'failed', rowsAbsent: 1, error: 'replayed', toolReported: itemsAnswer(['FIB-0016', 'updated', ['description']]) });
    expect(stopMessage(new MigrationStopped(new Error('boom'), true, [none, replayed]))).not.toContain('overwritten');
  });
  it('B12-1 (round 12): an unconfirmed batch names what its LIVE answer says it may have updated, not the dry run\'s', () => {
    const lost = base('item', 2, { status: 'failed', commitUnconfirmed: true, error: 'COMMIT failed', toolReported: itemsAnswer(['FIB-0016', 'updated', ['description']], ['FIB-0017', 'updated', ['name']]) });
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [lost], { failed: [] }));
    expect(m).toContain("commit unconfirmed: item batch 2 (key-item-2)\n  may have been updated to Sage's values (check the books): item FIB-0016 (description)\n  may have been updated to Sage's values (check the books): item FIB-0017 (name)");
  });
  it('round 22: without a live answer, never the dry run\'s: what it may have updated is not known', () => {
    const lost = base('item', 2, { status: 'failed', commitUnconfirmed: true, error: 'COMMIT failed' });
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [lost], { failed: [] }));
    expect(m).toContain('commit unconfirmed: item batch 2 (key-item-2)\n  what it may have updated is not known (no live answer): check the books');
    expect(m).not.toMatch(/dry run's answer|may have been updated/);
  });
  it('B12-2/3 + R1 (round 12): a committed batch the books check found changed is "committed", every overwrite named, only the changed rows "then changed"', () => {
    const b = base('item', 1, { status: 'failed', rowsAbsent: 1, changedAfterCommit: true, changedRows: ['FIB-0003'], error: 'committed, but ...',
      toolReported: itemsAnswer(['FIB-0002', 'updated', ['description']], ['FIB-0003', 'updated', ['is_active']]) });
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [b]));
    expect(m).toContain('committed: item batch 1 (key-item-1) (then changed or removed in the books by another writer: FIB-0003: check)');
    expect(m).toContain("  was updated to Sage's values (another row of its batch changed since: check): item FIB-0002 (description)");
    expect(m).toContain("  was updated to Sage's values, then changed in the books since (check): item FIB-0003 (is_active)");
    expect(m).not.toMatch(/nothing written|--run-tag|replayed/);
  });
});

describe('R3: batches refused before the stop', () => {
  it('are listed "failed, nothing written" with the tool\'s reason, after the committed ones', () => {
    const refused = base('item', 2, { status: 'failed', error: 'Not found: category 13' });
    const m = stopMessage(new MigrationStopped(new Error('lock lost'), true, [base('item', 1)], { failed: [refused] }));
    expect(m).toMatch(/committed: item batch 1 \(key-item-1\)\nfailed, nothing written: item batch 2 \(key-item-2\): Not found: category 13$/);
  });
  it('a long reason is cut as the console cuts it', () => {
    const refused = base('purchase_order', 1, { status: 'failed', error: 'x'.repeat(2000) });
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [], { failed: [refused] }));
    expect(m).toMatch(/failed, nothing written: purchase_order batch 1 \(key-purchase_order-1\): x+ \.\.\. \(2000 characters/);
  });
  it('a stop before the live phase lists nothing', () => {
    expect(stopMessage(new MigrationStopped(new Error('boom'), false, [], { failed: [base('item', 1, { status: 'failed', error: 'x' })] }))).toBe('sage migration stopped: boom');
  });
});

describe('L3 (round 13): an unconfirmed batch the tool refused', () => {
  it('says the refusal, never "may have been updated" (not even from the dry run)', () => {
    const b = base('item', 2, { status: 'failed', commitUnconfirmed: true, toolRefused: true, error: 'the tool refused this batch (code_in_use); its COMMIT was not confirmed' });
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [b], { failed: [] }));
    expect(m).toContain('commit unconfirmed: item batch 2 (key-item-2)\n  the tool refused this batch (code_in_use); its COMMIT was not confirmed');
    expect(m).not.toMatch(/may have been updated|FIB-0016/);
  });
});

describe('R21-6: a replayed answer whose COMMIT was lost', () => {
  it('is listed nothing written (a replay writes no rows), and its line says both: replayed, and the connection lost', () => {
    const failed = base('item', 1, { status: 'failed', error: 'Client has encountered a connection error and is not queryable' });
    const b = unconfirmedBatch(failed, base('item', 1, { replayed: true, toolReported: itemsAnswer(['FIB-0002', 'updated', ['description']]) }), true);
    const stop = new MigrationStopped(new Error('boom'), true, [b]);
    expect(stopReportBatches(stop).nothingWritten).toEqual([b]);
    expect(stopMessage(stop)).toContain('answered from a stored answer, nothing written: item batch 1 (key-item-1)\n  its COMMIT was not confirmed, which changes nothing for a replay (the connection was lost; its COMMIT was not confirmed (Client has encountered a connection error and is not queryable))');
  });
  it('a replayed answer whose COMMIT was confirmed keeps its plain line', () => {
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [base('item', 1, { replayed: true })]));
    expect(m.endsWith('answered from a stored answer, nothing written: item batch 1 (key-item-1)')).toBe(true); // nothing under it
  });
});

