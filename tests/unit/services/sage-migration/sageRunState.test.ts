/**
 * scripts/sage-migration/runState.ts (round 18 decision): what the CLI keeps of the runner's progress, and the stop it reports when the
 * run ends at once (a second signal, an uncaught error).
 */
import { describe, expect, it } from 'vitest';
import { RunState } from '../../../../scripts/sage-migration/runState';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const b = (entity: BatchReport['entity'], n: number, over: Partial<BatchReport> = {}): BatchReport => ({
  entity, n, size: 1, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: {}, error: null, ...over,
});
const head = (x: BatchReport) => ({ entity: x.entity, n: x.n, size: x.size, key: x.key });

describe('RunState', () => {
  it('before the live phase: a plain error (exit 2), whatever the dry run recorded', () => {
    const s = new RunState();
    s.onProgress({ kind: 'phase', phase: 'dry' });
    s.onProgress({ kind: 'recorded', phase: 'dry', batch: b('category', 1) });
    const e = s.stoppedAtOnce('stopped at once');
    expect(e).not.toBeInstanceOf(MigrationStopped);
    expect(e.message).toBe('stopped at once');
    expect(s.liveStarted).toBe(false);
  });
  it('live: recorded ok and unconfirmed batches are committed, a failed one failed, a recorded one no longer in flight', () => {
    const s = new RunState();
    s.onProgress({ kind: 'phase', phase: 'live' });
    for (const [x, over] of [[b('category', 1), {}], [b('category', 2), { status: 'failed', error: 'refused' }], [b('item', 1), { status: 'failed', commitUnconfirmed: true }]] as const) {
      const batch = { ...x, ...over } as BatchReport;
      s.onProgress({ kind: 'sending', batch: head(batch) });
      s.onProgress({ kind: 'recorded', phase: 'live', batch });
    }
    const e = s.stoppedAtOnce('stopped at once') as MigrationStopped;
    expect(e).toBeInstanceOf(MigrationStopped);
    expect(e.liveStarted).toBe(true);
    expect(e.message).toMatch(/not re-checked against the books/);
    expect(e.committed.map((x) => `${x.entity} ${x.n}`)).toEqual(['category 1', 'item 1']);
    expect(e.batches.failed.map((x) => `${x.entity} ${x.n}`)).toEqual(['category 2']);
  });
  it('a batch in flight is listed commit unconfirmed (its COMMIT may or may not have landed)', () => {
    const s = new RunState();
    s.onProgress({ kind: 'phase', phase: 'live' });
    s.onProgress({ kind: 'sending', batch: head(b('item', 3)) });
    const e = s.stoppedAtOnce('x') as MigrationStopped;
    expect(e.committed).toEqual([expect.objectContaining({ entity: 'item', n: 3, commitUnconfirmed: true, status: 'failed', error: expect.stringMatching(/in flight/) })]);
  });
  it('round 22: keeps nothing of the dry run (a stop never words a live batch from the dry run\'s answer)', () => {
    const s = new RunState();
    for (const x of [b('category', 1), b('item', 1)]) s.onProgress({ kind: 'recorded', phase: 'dry', batch: x });
    s.onProgress({ kind: 'phase', phase: 'live' });
    const e = s.stoppedAtOnce('x') as MigrationStopped;
    expect(e.committed).toEqual([]);
    expect(e.batches).toEqual({ failed: [] });
  });
});
