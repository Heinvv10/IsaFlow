/**
 * R26-4, R27-3, R28-2..5: what a lock's holder is told. Ending it is offered only for a migration transaction left open: our application
 * name, idle in a transaction ("aborted" included) in two samples apart with its state unchanged, older than this run's lock. Any other
 * session idle in a transaction is named (application, state, ages) and left to whoever owns it. The server's ending is said only from
 * the holder's own role / database default. A holder that is itself waiting is never "at work"; a cycle is named as a deadlock.
 * R27-7: a failed holder lookup is "could not be read". R27-8 / R28-3: a held LIVE key never claims an unconfirmed COMMIT; one idle when
 * looked up had not received a COMMIT then. R27-1: a 57014 is worded by how long it ran.
 */
import { describe, expect, it } from 'vitest';
import { BatchKeyHeldError, LockWaitError, LostBeforeCommitError, StatementTimeoutError } from '@/modules/accounting/services/sage-migration/sageSessionErrors';
import { SAGE_APP_NAME } from '@/modules/accounting/services/sage-migration/sageTimeouts';
import { idleSettingMs } from '@/modules/accounting/services/sage-migration/sageLockHolder';

const wait = (holder?: ConstructorParameters<typeof LockWaitError>[1]) => new LockWaitError(new Error('canceling statement due to lock timeout'), holder, 'dry').message;

/** Our own application, idle in a transaction, confirmed across two samples and older than this run's lock: the only "left open". */
const own = { app: SAGE_APP_NAME, state: 'idle in transaction', confirmedIdle: true, olderThanRun: true };

describe('the holder hint', () => {
  it("a migration transaction left open: ours, idle, confirmed by two samples, older than this run: ending it is offered, its client MAY be gone", () => {
    expect(wait({ pid: 5, ...own, ageS: 40, idleS: 30, idleMs: null }))
      .toContain(`held by backend pid 5, idle in transaction, application ${SAGE_APP_NAME}, in a transaction for 40 s, idle for 30 s: a migration transaction left open, from before this run (its client may be gone); SELECT pg_terminate_backend(5) ends it)`);
  });
  it('"idle in transaction (aborted)" is a transaction left open too, never "at work" (R27-3)', () => {
    const m = wait({ pid: 5, ...own, state: 'idle in transaction (aborted)' });
    expect(m).toContain('a migration transaction left open');
    expect(m).not.toMatch(/at work/);
  });
  it('R28-4 / B28-3: our application name alone is not enough: one sample, or a transaction from after this run took its lock, is "check with whoever owns it"', () => {
    for (const h of [{ ...own, confirmedIdle: false }, { ...own, confirmedIdle: undefined }, { ...own, olderThanRun: false }, { ...own, app: 'IsaFlow web' }]) {
      const m = wait({ pid: 3702489, ...h });
      expect(m, JSON.stringify(h)).toContain("another session's open transaction; check with whoever owns it before ending it");
      expect(m, JSON.stringify(h)).not.toMatch(/pg_terminate_backend|left open/);
    }
  });
  it("another application's session idle in transaction: its pid, app, state and ages; never offered for ending (hd1/hd2)", () => {
    const m = wait({ pid: 745255, state: 'idle in transaction', app: 'IsaFlow web: invoice edit (lew@client)', ageS: 12, idleS: 11 });
    expect(m).toContain("held by backend pid 745255, idle in transaction, application IsaFlow web: invoice edit (lew@client), in a transaction for 12 s, idle for 11 s: another session's open transaction; check with whoever owns it before ending it)");
    expect(m).not.toMatch(/pg_terminate_backend|ends it once/);
  });
  it("R28-2 / B28-4: the server's ending is said only from the holder's own role/database default, and as a default", () => {
    expect(wait({ pid: 9, state: 'idle in transaction', app: 'x', idleMs: 25_000 })).toContain("; its role's or database's default (idle_in_transaction_session_timeout 25 s) ends it once it has been idle that long, unless its session set its own");
    expect(wait({ pid: 9, ...own, idleMs: 0 })).not.toMatch(/ends it once/);
    expect(wait({ pid: 9, ...own, idleMs: null })).not.toMatch(/ends it once/);
  });
  it('B28-5: a holder that is itself waiting is never "at work"; a cycle through this run\'s request is a deadlock, with the hint', () => {
    const waiting = wait({ pid: 536684, state: 'active', app: 'IsaFlow web: chain W10', waiting: true, chain: [527709, 536684] });
    expect(waiting).toContain('held by backend pid 536684, active, application IsaFlow web: chain W10: it is itself waiting on a lock (backend pids 527709, 536684) and no session ahead of it could be named as the root');
    expect(waiting).not.toMatch(/at work/);
    const cycle = wait({ pid: 1607589, state: 'active', app: 'IsaFlow web: stock take', waiting: true, cycle: true, chain: [1607589] });
    expect(cycle).toContain("a lock cycle with this run's own request (backend pids 1607589): a deadlock the server breaks once a waiting session's deadlock check runs; this request gives way at its lock_timeout at the latest; then re-run");
    expect(cycle).not.toMatch(/deadlock_timeout \(/); // the holder's own deadlock_timeout cannot be seen: no value is promised (dl3)
    expect(cycle).not.toMatch(/at work/);
  });
  it('at work (active, not waiting): named with its state and application; waited for, never ended', () => {
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

describe('idleSettingMs: pg_db_role_setting values', () => {
  it('reads the units PostgreSQL takes (bare is ms)', () => {
    expect(['idle_in_transaction_session_timeout=25s', 'idle_in_transaction_session_timeout=25000', 'idle_in_transaction_session_timeout=1min', "idle_in_transaction_session_timeout='2h'", 'idle_in_transaction_session_timeout=0', 'x', null].map(idleSettingMs))
      .toEqual([25_000, 25_000, 60_000, 7_200_000, 0, null, null]);
  });
});

describe('R27-8 / R28-3: a held LIVE key, and a live loss by read timeout', () => {
  it('never claims an unconfirmed COMMIT', () => {
    for (const h of [undefined, { pid: 3, state: 'active', app: SAGE_APP_NAME }, { pid: 3, ...own }]) {
      expect(new BatchKeyHeldError(h, 'live').message).not.toMatch(/COMMIT was not confirmed/);
    }
  });
  it('a holder idle in its transaction had not received a COMMIT WHEN LOOKED UP (a snapshot); ours left open is offered for ending', () => {
    const m = new BatchKeyHeldError({ pid: 3, ...own }, 'live').message;
    expect(m).toContain('it had not received a COMMIT when looked up (it was idle in its transaction), so nothing of it was committed then; check the books, then re-run');
    expect(m).toContain('SELECT pg_terminate_backend(3) ends it');
    expect(m).not.toMatch(/never sent a COMMIT/);
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
