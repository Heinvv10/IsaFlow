/**
 * Round-11 breaker B11-3 and review R3: a stop after the live phase started says, per batch, what it did to the books.
 *   - a committed batch lists the owned items / categories it put back to Sage's values (the IsaFlow edit is overwritten): the dry run the
 *     message recommends no longer shows them once they are;
 *   - a batch whose COMMIT is unconfirmed lists what it MAY have updated (from the dry run's answer for that batch);
 *   - a batch refused earlier in the run is listed "failed, nothing written" with its reason.
 */
import { describe, expect, it } from 'vitest';
import { stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';
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
  it('a batch whose COMMIT is unconfirmed names what it MAY have updated, from the dry run\'s answer for that batch', () => {
    const lost = base('item', 2, { status: 'failed', commitUnconfirmed: true, error: 'COMMIT failed' });
    const dry = [base('item', 1, { key: 'dry-1', toolReported: itemsAnswer(['FIB-0002', 'updated', ['description']]) }),
      base('item', 2, { key: 'dry-2', toolReported: itemsAnswer(['FIB-0016', 'updated', ['description', 'sales_price']]) })];
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [lost], { failed: [], dryRun: dry }));
    expect(m).toContain("commit unconfirmed: item batch 2 (key-item-2)\n  may have been updated to Sage's values (check the books): item FIB-0016 (description, sales_price)");
    expect(m).not.toContain('FIB-0002');
  });
});

describe('R3: batches refused before the stop', () => {
  it('are listed "failed, nothing written" with the tool\'s reason, after the committed ones', () => {
    const refused = base('item', 2, { status: 'failed', error: 'Not found: category 13' });
    const m = stopMessage(new MigrationStopped(new Error('lock lost'), true, [base('item', 1)], { failed: [refused], dryRun: [] }));
    expect(m).toMatch(/committed: item batch 1 \(key-item-1\)\nfailed, nothing written: item batch 2 \(key-item-2\): Not found: category 13$/);
  });
  it('a long reason is cut as the console cuts it', () => {
    const refused = base('purchase_order', 1, { status: 'failed', error: 'x'.repeat(2000) });
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [], { failed: [refused], dryRun: [] }));
    expect(m).toMatch(/failed, nothing written: purchase_order batch 1 \(key-purchase_order-1\): x+ \.\.\. \(2000 characters/);
  });
  it('a stop before the live phase lists nothing', () => {
    expect(stopMessage(new MigrationStopped(new Error('boom'), false, [], { failed: [base('item', 1, { status: 'failed', error: 'x' })], dryRun: [] }))).toBe('sage migration stopped: boom');
  });
});
