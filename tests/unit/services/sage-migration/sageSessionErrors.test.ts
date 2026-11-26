/** R26-4: what a lock's holder is told, by its state: ending it is offered only for one idle in transaction. */
import { describe, expect, it } from 'vitest';
import { BatchKeyHeldError, LockWaitError } from '@/modules/accounting/services/sage-migration/sageSessionErrors';

const wait = (holder?: ConstructorParameters<typeof LockWaitError>[1]) => new LockWaitError(new Error('canceling statement due to lock timeout'), holder, 'dry').message;

describe('the holder hint', () => {
  it('idle in transaction: a transaction left open; ending it is offered', () => {
    expect(wait({ pid: 5, state: 'idle in transaction' })).toContain('held by backend pid 5, idle in transaction: a transaction left open; wait for the server to end it, or SELECT pg_terminate_backend(5)');
  });
  it('at work (active, any state but idle in transaction): named with its state and application; waited for, never ended', () => {
    const m = wait({ pid: 6, state: 'active', app: 'psql' });
    expect(m).toContain('held by backend pid 6, active, application psql: it is at work; wait for it to finish');
    expect(m).not.toMatch(/pg_terminate_backend/);
  });
  it('a state that could not be read: said so, check it first; never "at work", never ended blind', () => {
    const m = wait({ pid: 7, state: null });
    expect(m).toContain('held by backend pid 7 (its state could not be read): check what it is in pg_stat_activity before ending it');
    expect(m).not.toMatch(/pg_terminate_backend|at work/);
  });
  it('no holder seen: pid unknown, waited for', () => {
    expect(wait()).toContain('held by backend pid unknown: wait for it to end');
  });
  it('a held DRY key keeps the dry attribution (a dry key ends in -dry), with the same state rule', () => {
    expect(new BatchKeyHeldError({ pid: 8, state: 'active' }, 'dry').message).toBe("another session holds this batch's lock: likely a previous run's dry transaction (backend pid 8, active: it is at work; wait for it to finish); then re-run");
  });
});
