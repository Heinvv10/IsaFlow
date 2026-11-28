/**
 * R39r-1 / R39r-2 (round 39) against REAL pg-pool (its own checkout, release-once and destroy code; only the socket is a fake client).
 * A release wrapper that delegates and THEN throws leaves the client released to the pool, so the retry is pg-pool's double release,
 * which always throws: nothing is destroyed by it. The session and the run lock then close the connection through the pool's destroy
 * path: it leaves the pool (idle 0, total 0) and its socket is ended, so a run-lock connection cannot keep the advisory lock. A wrapper
 * that throws BEFORE delegating is destroyed by the retry itself. R39r-2: a run lock taken whose connection both releases fail says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Pool from 'pg-pool';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const h = vi.hoisted(() => ({ call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>() }));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }], call: h.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({ getCompanyMembership: async () => ({ rows: [{ account_user_id: 'u1', role: 'owner' }] }) }));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (_c: unknown, fn: () => unknown) => fn(), drainAfterCommit: () => undefined, settleAfterRollback: () => undefined }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';
import { acquireRunLock, RunLockNotTakenError } from '@/modules/accounting/services/sage-migration/sageRunLock';

/** The socket side only: pg-pool's own code does the rest. */
class FakeClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  ended = false;
  processID = 4242;
  static setFails = false;
  connect(cb: (e: Error | null) => void): void { setImmediate(() => cb(null)); }
  async query(text: string): Promise<{ rows: Array<Record<string, unknown>>; command: string }> {
    if (FakeClient.setFails && text.startsWith('SET idle_session_timeout')) throw new Error('SET refused');
    return { rows: [{ ok: true }], command: text.split(' ')[0]! };
  }
  end(cb?: () => void): Promise<void> { this.ended = true; this._ending = true; this._queryable = false; cb?.(); return Promise.resolve(); }
}

type Mode = 'after' | 'before' | 'always';
/** A real pool whose checked-out clients get a release wrapper: throws after delegating, before (once), or always without delegating. */
function hostilePool(mode: Mode) {
  const pool = new Pool({ Client: FakeClient as never, max: 4 });
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
      throw new Error('injected: release threw before delegating');
    };
    return c;
  };
  return { pool, clients };
}
const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const A = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { h.call.mockReset(); FakeClient.setFails = false; });

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
