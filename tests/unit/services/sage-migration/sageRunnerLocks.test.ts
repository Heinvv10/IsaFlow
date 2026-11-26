/**
 * Round 25, the runner's side of a wait on another session's lock, with its database seams mocked (the REAL error classes):
 *   - B25-1 / R25-1: the dry run stops at the FIRST lock wait (a held key, or a lock timeout the session reports), the batch named with who
 *     holds it; a --live run refuses its start (exit 2), a preview reports dry_run_failed (exit 1);
 *   - R25-3: in the live phase a held key or a lock timeout stops the run there (MigrationStopped, exit 4), no further batch sent;
 *   - R25-4: a DryRollbackUnconfirmedError with no result, or that followed the dry run's own error, is thrown, never kept;
 *   - B25-3: a run lock release that is not confirmed is said (in the report, or as a notice when the run itself stopped);
 *   - R27-1: a stall that made the call itself REJECT (the registry's bookkeeping, outside the tool's savepoint) stops the dry run at it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
import type { Send } from '@/modules/accounting/services/sage-migration/sageBatchRun';

const h = vi.hoisted(() => ({
  sent: [] as string[],
  held: null as string | null, // "<entity> <dry|live>": its key is held by another session
  lockWaitAt: null as string | null, // "<entity> dry": a lock timeout inside it (the session reports it)
  liveLockWaitAt: null as string | null, // "<entity> live": a lock timeout inside it (the committing session throws)
  dryHeldError: null as 'no-result' | 'after' | 'held-with-lockstop' | null,
  unlockWarning: null as string | null,
  stmtAt: null as string | null, // "<entity> <dry|live>": a statement timeout inside it
  callStall: null as string | null, // "<entity> dry": the call rejects with the session's stall (StatementTimeoutError)
  sessions: [] as Array<{ commit: boolean; wrote: boolean; notice: unknown; ended?: unknown }>,
  readFails: null as Error | null, // the books read after a stop fails with this (R29-6)
  lockNotice: undefined as unknown, // what the run lock was given to say a wait with (R27-6)
  failReadsAfterLive: false, // the books cannot be read once a live batch was sent (the stop's re-check fails)
  commitRefusedAt: null as string | null, // "<entity> live": the server refuses that batch's COMMIT (B28-2)
}));
vi.mock('@/modules/accounting/services/sage-migration/localGuard', () => ({ assertLocalDatabase: () => undefined, assertLocalPool: () => undefined }));
vi.mock('@/modules/accounting/services/sage-migration/sageRunLock', () => ({ acquireRunLock: async (_p: unknown, _c: unknown, notice?: unknown) => { h.lockNotice = notice; return { check: async () => undefined, unlock: async () => h.unlockWarning }; } }));
vi.mock('@/modules/accounting/services/sage-migration/sageToolSession', async () => {
  const real = await vi.importActual<typeof import('@/modules/accounting/services/sage-migration/sageSessionErrors')>('@/modules/accounting/services/sage-migration/sageSessionErrors');
  return {
    ...real,
    withToolSession: async (_p: unknown, _c: unknown, _u: unknown, commit: boolean, fn: (s: unknown) => unknown, o?: { wrote?: boolean; onNotice?: unknown }) => {
      h.sessions.push({ commit, wrote: o?.wrote === true, notice: o?.onNotice, ended: (o as { ended?: unknown } | undefined)?.ended });
      if (!commit && o?.wrote !== true && h.failReadsAfterLive && h.sent.some((x) => x.endsWith('live'))) throw h.readFails ?? new real.ConnectionLostError(new Error('Connection terminated due to connection timeout'), 'no-connection');
      const timedOut = () => new real.StatementTimeoutError(new Error('canceling statement due to statement timeout'), commit ? 'live' : 'dry', 60_000);
      const stall = () => (h.lockWaitAt !== null && h.sent.at(-1) === h.lockWaitAt ? new real.LockWaitError(new Error('canceling statement due to lock timeout'), { pid: 606, state: 'idle in transaction' }, 'dry')
        : h.stmtAt !== null && h.sent.at(-1) === h.stmtAt && !commit ? timedOut() : null);
      if (!commit && o?.wrote === true && h.dryHeldError === 'no-result') throw new real.DryRollbackUnconfirmedError(new Error('ROLLBACK did not answer'), 1, undefined);
      if (!commit && o?.wrote === true && h.dryHeldError === 'after') throw new real.DryRollbackUnconfirmedError(new Error('ROLLBACK did not answer'), 1, { categories: {} }, new Error('stopped by SIGTERM'));
      const r = await fn({ companyId: 'c', stall, call: async () => ({ isError: false, text: '{}', body: {} }) });
      if (!commit && o?.wrote === true && h.dryHeldError === 'held-with-lockstop') throw new real.DryRollbackUnconfirmedError(new Error('ROLLBACK did not answer'), 1, r);
      if (commit && h.stmtAt !== null && h.sent.at(-1) === h.stmtAt) throw timedOut();
      if (commit && h.commitRefusedAt !== null && h.sent.at(-1) === h.commitRefusedAt) throw new real.CommitRefusedError(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
      if (commit && h.liveLockWaitAt !== null && h.sent.at(-1) === h.liveLockWaitAt) throw new real.LockWaitError(new Error('canceling statement due to lock timeout'), { pid: 707, state: 'active', app: 'psql' }, 'live');
      return r;
    },
  };
});
vi.mock('@/modules/accounting/services/sage-migration/sageSuppliers', () => ({ resolveSuppliers: async () => new Map([['301', { id: '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6' }]]) }));
vi.mock('@/modules/accounting/services/sage-migration/sageSnapshot', () => ({
  readSnapshot: async () => ({
    itemRefs: new Set(), poTotals: new Map(), poStates: new Map(), poLinkedLines: new Map(), poContent: new Map(), duplicatePoRefs: new Map(), stockMovements: 0,
    budgetPolicy: 'warn', inactiveSuppliers: new Set(), supplierSageRefs: new Map(), poNumbers: new Map(), items: [], categories: [],
  }),
}));
vi.mock('@/modules/accounting/services/sage-migration/sageBatchRun', async (orig) => {
  const real = await vi.importActual<typeof import('@/modules/accounting/services/sage-migration/sageSessionErrors')>('@/modules/accounting/services/sage-migration/sageSessionErrors');
  return {
    ...(await orig<typeof import('@/modules/accounting/services/sage-migration/sageBatchRun')>()),
    sendBatch: async (_s: unknown, s: Send, _b: unknown, dry: boolean): Promise<BatchReport> => {
      const label = `${s.entity} ${dry ? 'dry' : 'live'}`;
      h.sent.push(label);
      if (h.held === label) throw new real.BatchKeyHeldError({ pid: 505, state: 'idle in transaction' }, dry ? 'dry' : 'live');
      if (h.callStall === label) throw new real.StatementTimeoutError(new Error('storniere Anfrage wegen Zeitüberschreitung der Anfrage'), 'dry', 60_000, 60_010);
      const fails = h.lockWaitAt === label || h.stmtAt === label;
      return { entity: s.entity, n: s.n, size: s.size, key: `k-${s.entity}-${s.n}`, allRowsAlreadyPresent: false, rowsAbsent: 0,
        status: fails ? 'failed' : 'ok', toolReported: fails ? null : (s.entity === 'item' ? { written: true, rows: [] } : { outcome: 'created' }), error: fails ? 'retry in a moment' : null };
    },
  };
});

import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

const parsed = () => parseSageExport({ Items: [
  { ID: 50, Code: 'FIB-50', Description: 'a', Active: true, Physical: true, Category: { ID: 10, Description: 'Optics' } },
  { ID: 51, Code: 'FIB-51', Description: 'b', Active: true, Physical: true, Category: { ID: 11, Description: 'Cable' } },
] });
const run = (over: Record<string, unknown> = {}) => runSageMigration({ options: { max: 4 } } as never, parsed(), { companyId: 'c', userId: 'u', live: true, expect: { items: 2, purchaseOrders: 0 }, ...over });
const live = () => h.sent.filter((x) => x.endsWith('live'));
beforeEach(() => { h.sent.length = 0; h.held = null; h.lockWaitAt = null; h.liveLockWaitAt = null; h.dryHeldError = null; h.unlockWarning = null; h.stmtAt = null; h.callStall = null; h.failReadsAfterLive = false; h.commitRefusedAt = null; h.readFails = null; h.sessions.length = 0; });

describe('R29-6: a books read that fails for any typed reason is worded from its cause', () => {
  it('a statement timeout or a lock wait: why the read failed, never its "nothing of it was written"', async () => {
    const { StatementTimeoutError, LockWaitError } = await import('@/modules/accounting/services/sage-migration/sageSessionErrors');
    for (const [readFails, want] of [
      [new StatementTimeoutError(new Error('canceling statement due to statement timeout'), 'dry', 60_000), 'a statement of it timed out or was cancelled: canceling statement due to statement timeout'],
      [new LockWaitError(new Error('canceling statement due to lock timeout'), { pid: 9 }, 'dry'), 'a lock it needed was held by another session (backend pid 9): canceling statement due to lock timeout'],
    ] as const) {
      Object.assign(h, { sent: [], liveLockWaitAt: 'category live', failReadsAfterLive: true, readFails });
      const err = await run().then(() => null, (e: unknown) => e) as InstanceType<typeof MigrationStopped>;
      expect(err.batches.booksNotRechecked).toBe(want);
    }
  });
});

describe('B28-2: a COMMIT the server refused', () => {
  it('is failed, nothing written, and the run stops there (exit 4); never "commit unconfirmed" or "may still land"', async () => {
    h.commitRefusedAt = 'category live';
    const err = await run().then(() => null, (e: unknown) => e) as InstanceType<typeof MigrationStopped>;
    expect(err).toBeInstanceOf(MigrationStopped);
    expect(err.batches.failed).toEqual([expect.objectContaining({ entity: 'category', n: 1, status: 'failed', error: 'the server refused the COMMIT (57014: canceling statement due to user request): the transaction was rolled back, nothing of it was written' })]);
    expect(err.committed.filter((b) => b.commitUnconfirmed)).toEqual([]);
    expect(err.message).not.toMatch(/may still land|did not answer/);
    expect(live()).toEqual(['category live']);
  });
});

describe('R27 wording: the books read after a stop fails', () => {
  it('the stop carries why, so the committed list is said not re-checked; a read that works carries nothing', async () => {
    h.liveLockWaitAt = 'category live';
    h.failReadsAfterLive = true;
    let err = await run().then(() => null, (e: unknown) => e) as InstanceType<typeof MigrationStopped>;
    expect(err).toBeInstanceOf(MigrationStopped);
    // B28-6: why the READ failed, never the read's own "nothing was sent, so nothing of it was written"
    expect(err.batches.booksNotRechecked).toBe('no connection could be had: Connection terminated due to connection timeout');
    expect(err.message).toMatch(/^category batch 1 .* failed: a lock it needs/); // the stop's own reason, not the read
    h.failReadsAfterLive = false;
    h.sent.length = 0;
    err = await run().then(() => null, (e: unknown) => e) as InstanceType<typeof MigrationStopped>;
    expect(err.batches.booksNotRechecked).toBeUndefined();
  });
});

describe('R27-1: a stall that rejected the call itself, in the dry run', () => {
  it('a preview: dry_run_failed, THAT batch failed with the stall; no later batch sent', async () => {
    h.callStall = 'category dry';
    const r = await run({ live: false });
    expect(r.status).toBe('dry_run_failed');
    expect(r.dryRun.categories.batches).toEqual([expect.objectContaining({ n: 1, status: 'failed', error: expect.stringMatching(/^a statement ran past the migration's 60 s statement_timeout/) })]);
    expect(h.sent).toEqual(['category dry']);
  });
  it('with --live: a refused start naming the batch (exit 2), nothing live sent', async () => {
    h.callStall = 'category dry';
    const err = await run().then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(MigrationStopped);
    expect(String(err)).toMatch(/^Error: the dry run stopped at category batch 1 \(sage-mig-category-0001-[0-9a-f]+-dry\): a statement ran past the migration's 60 s statement_timeout .*; the live run was not started$/);
    expect(live()).toEqual([]);
  });
});

describe('B25-1 / R25-1: the dry run stops at its first lock wait', () => {
  it('a lock timeout in category batch 1: a preview is dry_run_failed with THAT batch named, who holds it said; no later batch sent', async () => {
    h.lockWaitAt = 'category dry';
    const r = await run({ live: false });
    expect(r.status).toBe('dry_run_failed');
    expect(r.dryRun.categories.batches).toEqual([expect.objectContaining({ n: 1, status: 'failed', error: expect.stringMatching(/timed out .*held by backend pid 606, idle in transaction, application \(none\): another session's open transaction; check with whoever owns it before ending it/) })]);
    expect(h.sent).toEqual(['category dry']); // not 2 categories x their own lock timeout
    expect(summaryLines(r).join('\n')).toMatch(/FAILED category batch 1 \(dry run\): a lock it needs is held by another session/);
  });
  it('with --live: a refused start naming the batch (exit 2), nothing live sent', async () => {
    h.lockWaitAt = 'category dry';
    const err = await run().then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(MigrationStopped);
    expect(String(err)).toMatch(/^Error: the dry run stopped at category batch 1 \(k-category-1\): a lock it needs is held by another session .*; the live run was not started$/);
    expect(live()).toEqual([]);
  });
  it('a held key in the dry run (R25-1): the same, the batch named with the holder', async () => {
    h.held = 'category dry';
    const err = await run().then(() => null, (e: unknown) => e);
    expect(String(err)).toMatch(/the dry run stopped at category batch 1 \(.*\): another session holds this batch's lock: likely a previous run's dry transaction, or a different key with the same 32-bit hash \(backend pid 505, idle in transaction/);
    expect(h.sent).toEqual(['category dry']);
  });
});

describe('R25-3: in the live phase a held key or a lock timeout stops the run (exit 4), nothing of that batch written', () => {
  for (const [what, set] of [['a held key', () => { h.held = 'category live'; }], ['a lock timeout', () => { h.liveLockWaitAt = 'category live'; }]] as const) {
    it(what, async () => {
      set();
      const err = await run().then(() => null, (e: unknown) => e) as InstanceType<typeof MigrationStopped>;
      expect(err).toBeInstanceOf(MigrationStopped);
      expect(err.liveStarted).toBe(true);
      expect(err.batches.failed).toEqual([expect.objectContaining({ entity: 'category', n: 1, status: 'failed', error: expect.stringMatching(/a live transaction that has not ended \(a previous run's, another client using the same key, or a different key with the same 32-bit hash\): backend pid 505, idle in transaction, application \(none\): another session's open transaction; check with whoever owns it before ending it; it had not received a COMMIT when looked up|held by backend pid 707, active, application psql: it is at work; wait for it to finish/) })]);
      expect(live()).toEqual(['category live']); // the second category, the items: never sent
    });
  }
});

describe('R25-4: a dry ROLLBACK not confirmed that cannot be kept', () => {
  it('with no result: thrown as it is (never a TypeError from an absent dry result)', async () => {
    h.dryHeldError = 'no-result';
    expect(String(await run({ live: false }).then(() => null, (e: unknown) => e))).toMatch(/^DryRollbackUnconfirmedError: the dry run's ROLLBACK was not confirmed/);
  });
  it('after the dry run\'s own error: thrown as it is', async () => {
    h.dryHeldError = 'after';
    expect(String(await run({ live: false }).then(() => null, (e: unknown) => e))).toMatch(/^DryRollbackUnconfirmedError: stopped by SIGTERM; and the dry run's ROLLBACK was not confirmed/);
  });
});

describe('B25-3: a run lock release not confirmed', () => {
  it('a finished run carries it (and its summary says it); a stopped one says it as a notice', async () => {
    h.unlockWarning = 'its run lock release was not confirmed (no answer within 10 s); backend pid 3';
    const r = await run({ live: false });
    expect(r.runLockUnconfirmed).toBe(h.unlockWarning);
    expect(summaryLines(r)).toContain(`WARNING: ${h.unlockWarning}`);
    const notices: string[] = [];
    h.lockWaitAt = 'category dry';
    await run({ onNotice: (l: string) => notices.push(l) }).catch(() => null);
    expect(notices).toEqual([`WARNING: ${h.unlockWarning}`]);
  });
});

describe('R26-3 / R27-6: every session of the run gets onNotice (the run lock, the plan, the dry run, each live batch, the reads between and after)', () => {
  it('a finished live run, and a stopped one (its books read after the stop included)', async () => {
    const onNotice = vi.fn();
    const ended = () => null;
    await run({ onNotice, ended });
    expect(h.sessions.map((x) => `${x.commit ? 'live' : x.wrote ? 'dry' : 'read'}`)).toEqual(['read', 'dry', 'live', 'live', 'read', 'read']); // the plan, the dry run, 2 live categories, the reads after them
    expect(h.sessions.every((x) => x.ended === ended)).toBe(true); // R29-1: every session can refuse once the run ended
    expect(h.sessions.every((x) => x.notice === onNotice)).toBe(true);
    expect(h.lockNotice).toBe(onNotice); // R27-6: the run lock's connect too
    h.sessions.length = 0;
    h.liveLockWaitAt = 'category live';
    await run({ onNotice }).catch(() => null);
    expect(h.sessions.at(-1)).toMatchObject({ commit: false, wrote: false }); // settled(): the books read after the stop
    expect(h.sessions.every((x) => x.notice === onNotice)).toBe(true);
  });
});

describe('B26-4: a statement timeout stops the run where it happened', () => {
  it('in the dry run: dry_run_failed (preview) at that batch, named; no later batch sent', async () => {
    h.stmtAt = 'category dry';
    const r = await run({ live: false });
    expect(r.dryRun.categories.batches).toEqual([expect.objectContaining({ n: 1, status: 'failed', error: expect.stringMatching(/^a statement ran past the migration's 60 s statement_timeout/) })]);
    expect(h.sent).toEqual(['category dry']);
  });
  it('in the live phase: MigrationStopped (exit 4), that batch failed, nothing later sent', async () => {
    h.stmtAt = 'category live';
    const err = await run().then(() => null, (e: unknown) => e) as InstanceType<typeof MigrationStopped>;
    expect(err).toBeInstanceOf(MigrationStopped);
    expect(err.batches.failed).toEqual([expect.objectContaining({ entity: 'category', n: 1, error: expect.stringMatching(/statement_timeout/) })]);
    expect(live()).toEqual(['category live']);
  });
});

describe('R26-6: a dry run that stopped on a lock AND whose ROLLBACK is not confirmed', () => {
  it('under --live the refusal keeps the held-writes warning', async () => {
    h.lockWaitAt = 'category dry';
    h.dryHeldError = 'held-with-lockstop';
    const err = await run().then(() => null, (e: unknown) => e);
    expect(String(err)).toMatch(/the live run was not started; the dry run's ROLLBACK was not confirmed \(ROLLBACK did not answer\); its writes may still be held \(backend pid 1/);
  });
});

