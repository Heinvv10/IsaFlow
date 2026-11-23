/** L3 (round 4): the stop message follows whether the live phase actually started, not the command line. */
import { describe, expect, it } from 'vitest';
import { exitCodeForError, stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const batch = (entity: BatchReport['entity'], n: number, status: BatchReport['status'] = 'ok'): BatchReport =>
  ({ entity, n, size: 1, key: `key-${entity}-${n}`, status, allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, error: null });

describe('stopMessage', () => {
  it('a plain error says only why, whatever the command line was', () => {
    expect(stopMessage(new Error('boom'))).toBe('sage migration stopped: boom');
    expect(stopMessage('plain')).toBe('sage migration stopped: plain');
  });
  it('a stop BEFORE the live phase started claims no commit', () => {
    expect(stopMessage(new MigrationStopped(new Error('boom'), false, []))).toBe('sage migration stopped: boom');
  });
  it('a stop after the live phase started says the run may have committed, and lists the batches that did', () => {
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [batch('category', 1), batch('item', 1), batch('item', 2, 'failed')]));
    expect(m).toContain('sage migration stopped: boom');
    expect(m).toMatch(/the live run may already have committed.*check the books.*dry run/s);
    expect(m).toContain('committed: category batch 1 (key-category-1)');
    expect(m).toContain('committed: item batch 1 (key-item-1)');
    expect(m).not.toContain('item batch 2'); // a failed batch is not listed as committed
  });
  it('a live stop with nothing committed yet still says it may have', () => {
    expect(stopMessage(new MigrationStopped(new Error('x'), true, []))).toMatch(/may already have committed/);
  });
});

describe('L2 (round 6): a batch whose COMMIT answer was lost is listed apart', () => {
  it('"commit unconfirmed" with its key, next to the committed ones', () => {
    const lost: BatchReport = { ...batch('item', 2, 'failed'), commitUnconfirmed: true, error: 'COMMIT failed' };
    const m = stopMessage(new MigrationStopped(new Error('boom'), true, [batch('category', 1), lost]));
    expect(m).toContain('committed: category batch 1 (key-category-1)');
    expect(m).toContain('commit unconfirmed: item batch 2 (key-item-2)');
    expect(m).not.toContain('committed: item batch 2');
  });
});

describe('MigrationStopped', () => {
  it('keeps the cause\'s message and the batches, and is an Error', () => {
    const e = new MigrationStopped(new Error('inner'), true, [batch('item', 1)]);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('inner');
    expect(e.committed).toHaveLength(1);
    expect(new MigrationStopped('text', false, []).message).toBe('text');
  });
});

describe('exitCodeForError (M1, round 5): 2 is "refused to start, nothing written"; a stop after the live phase started is 4', () => {
  it('a plain error, or a stop before the live phase, is 2', () => {
    expect(exitCodeForError(new Error('x'))).toBe(2);
    expect(exitCodeForError('text')).toBe(2);
    expect(exitCodeForError(new MigrationStopped(new Error('x'), false, []))).toBe(2);
  });
  it('a stop after the live phase started is 4, with or without batches committed', () => {
    expect(exitCodeForError(new MigrationStopped(new Error('x'), true, []))).toBe(4);
    expect(exitCodeForError(new MigrationStopped(new Error('x'), true, [batch('item', 1)]))).toBe(4);
  });
});
