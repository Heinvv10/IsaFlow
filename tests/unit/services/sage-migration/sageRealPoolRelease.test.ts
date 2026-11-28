/**
 * R39r-1 / R39r-2 (round 39) against REAL pg-pool (pg.Pool, the CLI's own: its checkout, release-once and destroy code; only the socket
 * is a fake client, given as pg-pool's `Client` option). Also the fix-review findings: MED (an error while the connection is closed is
 * listened to), L2 (a queued waiter is woken when the slot is freed), L4 (a client the pool already handed on is left alone).
 * A release wrapper that delegates and THEN throws leaves the client released to the pool, so the retry is pg-pool's double release,
 * which always throws: nothing is destroyed by it. The session and the run lock then close the connection through the pool's destroy
 * path: it leaves the pool (idle 0, total 0) and its socket is ended, so a run-lock connection cannot keep the advisory lock. A wrapper
 * that throws BEFORE delegating is destroyed by the retry itself. R39r-2: a run lock taken whose connection both releases fail says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const h = vi.hoisted(() => ({ call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>() }));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }], call: h.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({ getCompanyMembership: async () => ({ rows: [{ account_user_id: 'u1', role: 'owner' }] }) }));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (_c: unknown, fn: () => unknown) => fn(), drainAfterCommit: () => undefined, settleAfterRollback: () => undefined }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';
import { acquireRunLock, RunInProgressError, RunLockNotTakenError } from '@/modules/accounting/services/sage-migration/sageRunLock';

/** The socket side only: pg-pool's own code does the rest. */
class FakeClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  ended = false;
  processID = 4242;
  static setFails = false;
  static lockHeld = false;
  connect(cb: (e: Error | null) => void): void { setImmediate(() => cb(null)); }
  ref(): void { /* pg-pool refs an idle client it hands out; nothing to hold here */ }
  unref(): void { /* and unrefs one under allowExitOnIdle */ }
  async query(text: string): Promise<{ rows: Array<Record<string, unknown>>; command: string }> {
    if (FakeClient.setFails && text.startsWith('SET idle_session_timeout')) throw new Error('SET refused');
    if (FakeClient.lockHeld && text.includes('pg_try_advisory_lock')) return { rows: [{ ok: false }], command: 'SELECT' };
    return { rows: [{ ok: true }], command: text.split(' ')[0]! };
  }
  end(cb?: () => void): Promise<void> { this.ended = true; this._ending = true; this._queryable = false; cb?.(); return Promise.resolve(); }
}

type Mode = 'after' | 'before' | 'always' | 'foreign';
/** A real pool whose checked-out clients get a release wrapper: throws after delegating, before (once), or always without delegating. */
function hostilePool(mode: Mode, max = 4) {
  const pool = new pg.Pool({ Client: FakeClient as never, max } as never);
  const clients: FakeClient[] = [];
  const connect = pool.connect.bind(pool) as () => Promise<FakeClient & { release: (e?: unknown) => void }>;
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
    const c = await connect();
    clients.push(c);
    const real = c.release;
    let n = 0;
    c.release = (e?: unknown) => {
      if (mode === 'after') { real(e); throw new Error('injected: release threw after delegating'); }
      if (mode === 'before' && n++ > 0) return real(e);
      if (mode === 'foreign') (pool as unknown as { emit: (ev: string, c: unknown) => void }).emit('acquire', new FakeClient()); // another client checked out
      throw new Error('injected: release threw before delegating');
    };
    return c;
  };
  return { pool, clients };
}
const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const A = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { h.call.mockReset(); FakeClient.setFails = false; FakeClient.lockHeld = false; });

describe('R39r-1: the session, against real pg-pool', () => {
  for (const mode of ['after', 'before', 'always'] as const) {
    it(`a release that throws ${mode}: the connection leaves the pool and is closed; the call's outcome stands`, async () => {
      h.call.mockResolvedValueOnce(ok('{"created":1}'));
      const { pool, clients } = hostilePool(mode);
      await expect(withToolSession(pool as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }))).resolves.toMatchObject({ isError: false });
      await new Promise((r) => setImmediate(r));
      expect(clients[0]!.ended).toBe(true);
      expect([pool.idleCount, pool.totalCount]).toEqual([0, 0]);
    });
  }
});

describe('R39r-1 / R39r-2: the run lock, against real pg-pool', () => {
  for (const mode of ['after', 'before', 'always'] as const) {
    it(`unlock whose release throws ${mode}: not confirmed, the lock connection closed and out of the pool`, async () => {
      const { pool, clients } = hostilePool(mode);
      const lock = await acquireRunLock(pool as never, A);
      expect(await lock.unlock()).toMatch(/^its run lock release was not confirmed \(injected: release threw/);
      await new Promise((r) => setImmediate(r));
      expect(clients[0]!.ended).toBe(true);
      expect([pool.idleCount, pool.totalCount]).toEqual([0, 0]);
    });
  }
  it('the session setting fails after the lock was taken and both releases throw: the error says the lock may still be held, by which pid', async () => {
    FakeClient.setFails = true;
    const { pool, clients } = hostilePool('after');
    const err = await acquireRunLock(pool as never, A).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RunLockNotTakenError);
    expect((err as Error).message).toMatch(/the run lock had been taken and releasing its connection failed \(injected: release threw after delegating\), so it may still be held; its backend pid 4242/);
    expect(clients[0]!.ended).toBe(true);
    expect(pool.totalCount).toBe(0);
  });
  it('a release that throws only before delegating: the retry destroys it, and the error does not claim the lock may be held', async () => {
    FakeClient.setFails = true;
    const { pool } = hostilePool('before');
    const err = await acquireRunLock(pool as never, A).then(() => null, (e: unknown) => e);
    expect((err as Error).message).not.toMatch(/may still be held/);
    expect(pool.totalCount).toBe(0);
  });
});

describe('fix review: closing a connection in doubt, against real pg-pool', () => {
  const settle = () => new Promise((r) => setImmediate(r));
  it('MED: an error the client emits after it was closed is listened to, never an uncaught error (no listener of ours or pg-pool\'s left)', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    const { pool, clients } = hostilePool('always');
    await withToolSession(pool as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));
    await settle();
    expect(clients[0]!.ended).toBe(true);
    expect(clients[0]!.listenerCount('error')).toBeGreaterThan(0);
    expect(() => clients[0]!.emit('error', Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }))).not.toThrow();
  });
  it('L2: a request queued for the only slot gets a connection once the one in doubt is closed', async () => {
    const { pool } = hostilePool('always', 1);
    let waiter: Promise<unknown> | null = null;
    h.call.mockImplementationOnce(async () => { waiter = pool.connect(); return ok('{"created":1}'); });
    await withToolSession(pool as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));
    const got = await Promise.race([waiter!, new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
    expect(got).toBeInstanceOf(FakeClient);
    expect((got as FakeClient).ended).toBe(false);
  });
  it('L4: a clean release that hands the client to a queued request before the wrapper throws: neither released again nor closed', async () => {
    const { pool, clients } = hostilePool('after', 1);
    let waiter: Promise<FakeClient> | null = null;
    h.call.mockImplementationOnce(async () => { waiter = pool.connect() as Promise<FakeClient>; return ok('{"created":1}'); });
    await expect(withToolSession(pool as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }))).resolves.toMatchObject({ isError: false });
    const theirs = await waiter!;
    expect(theirs).toBe(clients[0]);
    expect(theirs.ended).toBe(false);
    expect([pool.totalCount, pool.idleCount]).toEqual([1, 0]);
  });
  it('L4, the run lock: unlock whose clean release hands it on before the wrapper throws: the waiter keeps a live connection', async () => {
    const { pool, clients } = hostilePool('after', 1);
    const lock = await acquireRunLock(pool as never, A);
    const waiter = pool.connect() as Promise<FakeClient>;
    expect(await lock.unlock()).toMatch(/not confirmed/);
    const theirs = await waiter;
    expect(theirs).toBe(clients[0]);
    expect(theirs.ended).toBe(false);
  });
  it('L4: only THIS client handed on counts; another checkout during the release does not stop the close; the watch is removed', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    const { pool, clients } = hostilePool('foreign');
    await withToolSession(pool as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));
    await settle();
    expect(clients[0]!.ended).toBe(true);
    expect(pool.listenerCount('acquire')).toBe(0);
    const lock = await acquireRunLock(pool as never, A);
    await lock.unlock();
    expect(pool.listenerCount('acquire')).toBe(0);
  });
  it('the clean path: a normal session and a normal lock / unlock on a real pg.Pool leave no checkout watch behind', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    const pool = new pg.Pool({ Client: FakeClient as never, max: 4 } as never);
    await withToolSession(pool as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));
    expect(pool.listenerCount('acquire')).toBe(0);
    const lock = await acquireRunLock(pool as never, A);
    expect(await lock.unlock()).toBeNull();
    expect(pool.listenerCount('acquire')).toBe(0);
    FakeClient.lockHeld = true; // another run holds it: the clean release of RunInProgressError's path
    await expect(acquireRunLock(pool as never, A)).rejects.toThrow(RunInProgressError);
    expect(pool.listenerCount('acquire')).toBe(0);
  });
  it('a first release that delegated: pg-pool\'s own idleListener is back, so an error goes to the pool\'s error event (the CLI says it)', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    const { pool, clients } = hostilePool('after');
    const poolErrors: unknown[] = [];
    pool.on('error', (e) => { poolErrors.push(e); });
    await withToolSession(pool as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));
    await settle();
    const boom = new Error('read ETIMEDOUT');
    expect(() => clients[0]!.emit('error', boom)).not.toThrow();
    expect(poolErrors).toEqual([boom]);
  });
});
