/**
 * R26-4, R27-3: what a lock's holder is told. Ending it is offered only for one of the migration's OWN sessions (its application name)
 * idle in a transaction ("aborted" included): a dead run's transaction left open. Any other session idle in a transaction (a user's
 * request between two statements looks just like that) is named with its application, state and age, and left to whoever owns it. "The
 * server ends it" only when idle_in_transaction_session_timeout is set. R27-7: a holder lookup that failed is "could not be read".
 * R27-8: a held LIVE key never claims an unconfirmed COMMIT; one idle in its transaction was never sent a COMMIT.
 */
import { describe, expect, it } from 'vitest';
import { BatchKeyHeldError, LockWaitError, LostBeforeCommitError, StatementTimeoutError } from '@/modules/accounting/services/sage-migration/sageSessionErrors';
import { SAGE_APP_NAME } from '@/modules/accounting/services/sage-migration/sageTimeouts';

const wait = (holder?: ConstructorParameters<typeof LockWaitError>[1]) => new LockWaitError(new Error('canceling statement due to lock timeout'), holder, 'dry').message;

describe('the holder hint', () => {
  it("the migration's own session idle in transaction: a migration transaction left open; ending it is offered", () => {
    expect(wait({ pid: 5, state: 'idle in transaction', app: SAGE_APP_NAME, ageS: 40, idleMs: 0 }))
      .toContain(`held by backend pid 5, idle in transaction, application ${SAGE_APP_NAME}, in a transaction for 40 s: a migration transaction left open (its client is gone); SELECT pg_terminate_backend(5) ends it)`);
  });
  it('"idle in transaction (aborted)" is a transaction left open too, never "at work" (R27-3)', () => {
    const m = wait({ pid: 5, state: 'idle in transaction (aborted)', app: SAGE_APP_NAME });
    expect(m).toContain('a migration transaction left open');
    expect(m).toContain('SELECT pg_terminate_backend(5)');
    expect(m).not.toMatch(/at work/);
  });
  it("another application's session idle in transaction: its pid, app, state and age; never offered for ending (hd1/hd2)", () => {
    const m = wait({ pid: 745255, state: 'idle in transaction', app: 'IsaFlow web: invoice edit (lew@client)', ageS: 12, idleMs: 0 });
    expect(m).toContain("held by backend pid 745255, idle in transaction, application IsaFlow web: invoice edit (lew@client), in a transaction for 12 s: another session's open transaction; check with whoever owns it before ending it)");
    expect(m).not.toMatch(/pg_terminate_backend|server ends/);
  });
  it('"the server ends it" only when idle_in_transaction_session_timeout is set', () => {
    expect(wait({ pid: 9, state: 'idle in transaction', app: 'x', idleMs: 30_000 })).toContain('; the server ends it once it has been idle 30 s (idle_in_transaction_session_timeout)');
    expect(wait({ pid: 9, state: 'idle in transaction', app: SAGE_APP_NAME, idleMs: 0 })).not.toMatch(/server ends/);
    expect(wait({ pid: 9, state: 'idle in transaction', app: SAGE_APP_NAME, idleMs: null })).not.toMatch(/server ends/);
  });
  it('at work (active): named with its state and application; waited for, never ended', () => {
    const m = wait({ pid: 6, state: 'active', app: 'psql' });
    expect(m).toContain('held by backend pid 6, active, application psql: it is at work; wait for it to finish');
    expect(m).not.toMatch(/pg_terminate_backend/);
  });
  it('a state that could not be read: said so, check it first; never "at work", never ended blind, even for our own app', () => {
    const m = wait({ pid: 7, state: null, app: SAGE_APP_NAME });
    expect(m).toContain(`held by backend pid 7, application ${SAGE_APP_NAME} (its state could not be read): check what it is in pg_stat_activity before ending it`);
    expect(m).not.toMatch(/pg_terminate_backend|at work/);
  });
  it('no holder seen: pid unknown, waited for', () => {
    expect(wait()).toContain('held by backend pid unknown: wait for it to end');
  });
  it('a held DRY key keeps the dry attribution (a dry key ends in -dry), with the same rule', () => {
    expect(new BatchKeyHeldError({ pid: 8, state: 'active' }, 'dry').message).toBe("another session holds this batch's lock: likely a previous run's dry transaction (backend pid 8, active, application (none): it is at work; wait for it to finish); then re-run");
  });
  it('R27-7: a holder lookup that failed is "could not be read", never "unknown"', () => {
    expect(new BatchKeyHeldError(undefined, 'dry', true).message).toContain('who holds it could not be read (the lookup failed; see the log)');
    expect(new BatchKeyHeldError(undefined, 'live', true).message).toContain('who holds it could not be read (the lookup failed; see the log)');
    expect(new BatchKeyHeldError(undefined, 'dry').message).toContain('backend pid unknown');
  });
});

describe('R27-8: a held LIVE key, and a live loss by read timeout', () => {
  it('never claims an unconfirmed COMMIT', () => {
    for (const h of [undefined, { pid: 3, state: 'active', app: SAGE_APP_NAME }, { pid: 3, state: 'idle in transaction', app: SAGE_APP_NAME }]) {
      expect(new BatchKeyHeldError(h, 'live').message).not.toMatch(/COMMIT was not confirmed/);
    }
  });
  it('a holder idle in its transaction was never sent a COMMIT: nothing of it is committed; ours is offered for ending', () => {
    const m = new BatchKeyHeldError({ pid: 3, state: 'idle in transaction', app: SAGE_APP_NAME }, 'live').message;
    expect(m).toContain('it was never sent a COMMIT (it is idle in its transaction), so nothing of it is committed');
    expect(m).toContain('SELECT pg_terminate_backend(3) ends it');
  });
  it('a holder at work may be committing: never offered for ending', () => {
    const m = new BatchKeyHeldError({ pid: 3, state: 'active', app: SAGE_APP_NAME }, 'live').message;
    expect(m).toContain('it may be committing, so do not terminate it');
    expect(m).not.toMatch(/pg_terminate_backend/);
  });
  it('a live loss by read timeout: nothing written, and its backend may still hold the locks and the key (pid)', () => {
    expect(new LostBeforeCommitError(new Error('Query read timeout'), { pid: 77 }).message).toBe("the connection was lost before its COMMIT was sent (Query read timeout); nothing of it was written; its backend may still hold the request's locks and the batch's key (backend pid 77, this run's own: SELECT pg_terminate_backend(77) ends it)");
    expect(new LostBeforeCommitError(new Error('Connection terminated unexpectedly')).message).toBe('the connection was lost before its COMMIT was sent (Connection terminated unexpectedly); nothing of it was written');
  });
});

describe('R27-1: a 57014 is worded by how long it ran, never by the server message', () => {
  const german = new Error('storniere Anfrage wegen Zeitüberschreitung der Anfrage');
  it('at or past the statement_timeout: it ran past it', () => {
    expect(new StatementTimeoutError(german, 'dry', 60_000, 60_004).message).toBe("a statement ran past the migration's 60 s statement_timeout (storniere Anfrage wegen Zeitüberschreitung der Anfrage); nothing of it was written: the database is overloaded or stalled; re-run once it answers");
  });
  it('sooner: someone else cancelled it', () => {
    expect(new StatementTimeoutError(german, 'live', 60_000, 2_340).message).toBe("a statement was cancelled after 2.3 s, before the migration's 60 s statement_timeout (57014: storniere Anfrage wegen Zeitüberschreitung der Anfrage): another session cancelled it (pg_cancel_backend); nothing of it was written; find out who, then re-run");
  });
});
