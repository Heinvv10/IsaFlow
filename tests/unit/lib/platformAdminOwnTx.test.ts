/**
 * withOwnPlatformAdminTx (WP7 review round 2 of #1368, M + L2): the one-off platform_admin transaction the
 * invoice Send commits its claim and finalise in. Against a fake pg.Client:
 *  - a socket 'error' event on the client is logged, never an uncaught exception (listener before connect);
 *  - the client is ended on every path: success, fn throws, connect fails, COMMIT fails, audit failure;
 *  - a failed critical audit write rolls back instead of committing;
 *  - the actor and claims come from the REQUEST context (and with none it refuses), with lock_timeout set.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ clients: [] as unknown[], logError: vi.fn(), failOn: null as null | string }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: m.logError, debug: vi.fn() } }));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  newPlatformAdminClient: () => {
    const c = Object.assign(new EventEmitter(), {
      queries: [] as Array<{ text: string; values?: unknown[] }>,
      connected: false,
      ended: 0,
      errorListenersAtConnect: -1,
      connect: vi.fn(async () => {
        c.errorListenersAtConnect = c.listenerCount('error');
        if (m.failOn === 'connect') throw new Error('connect refused');
        c.connected = true;
      }),
      query: vi.fn(async (text: string, values?: unknown[]) => {
        c.queries.push({ text, values });
        if (m.failOn && text.startsWith(m.failOn)) throw new Error(`${m.failOn} failed`);
        return { rows: [], rowCount: 0 };
      }),
      end: vi.fn(async () => { c.ended += 1; }),
    });
    m.clients.push(c);
    return c;
  },
}));

import { als, type RequestContext } from '@/lib/als';
import { withOwnPlatformAdminTx } from '@/lib/auth/platformAdminOwnTx';
import { registerImpersonationSession } from '@/lib/auth/impersonationSessions';

type Fake = EventEmitter & { queries: Array<{ text: string; values?: unknown[] }>; ended: number; errorListenersAtConnect: number };
const last = () => m.clients.at(-1) as Fake;
const texts = () => last().queries.map((q) => q.text);
const CLAIMS = { sub: 'admin-1', role: 'authenticated', email: 'a@x.example.test' };
const inRequest = <T>(fn: () => Promise<T>) =>
  als.run({ client: {} as RequestContext['client'], userId: 'admin-1', claims: CLAIMS, afterCommit: [] }, fn);

beforeEach(() => { m.clients.length = 0; m.failOn = null; m.logError.mockClear(); });

describe('withOwnPlatformAdminTx', () => {
  it('commits, with lock_timeout and the request claims set, and runs fn in its own context', async () => {
    let seen: { userId?: string; claims?: unknown; client?: unknown } = {};
    const out = await inRequest(() => withOwnPlatformAdminTx(async () => {
      const ctx = als.getStore();
      seen = { userId: ctx?.userId, claims: ctx?.claims, client: ctx?.client };
      return 42;
    }));
    expect(out).toBe(42);
    expect(texts()).toEqual(['BEGIN', "SET LOCAL lock_timeout = '5s'", "SELECT set_config('request.jwt.claims', $1, true)", 'COMMIT']);
    expect(last().queries[2]!.values).toEqual([JSON.stringify(CLAIMS)]);
    expect(seen).toEqual({ userId: 'admin-1', claims: CLAIMS, client: last() });
    expect(last().ended).toBe(1);
  });

  it('refuses outside a request context: no connection at all', async () => {
    await expect(withOwnPlatformAdminTx(async () => 1)).rejects.toThrow(/no request context/);
    expect(m.clients).toHaveLength(0);
  });

  it('a failed critical audit write rolls back, never commits, and ends the client', async () => {
    await expect(inRequest(() => withOwnPlatformAdminTx(async () => { als.getStore()!.criticalAuditFailed = true; })))
      .rejects.toThrow(/audit write failed/);
    expect(texts()).toContain('ROLLBACK');
    expect(texts()).not.toContain('COMMIT');
    expect(last().ended).toBe(1);
  });

  it('fn throwing rolls back and ends the client', async () => {
    await expect(inRequest(() => withOwnPlatformAdminTx(async () => { throw new Error('boom'); }))).rejects.toThrow('boom');
    expect(texts().at(-1)).toBe('ROLLBACK');
    expect(last().ended).toBe(1);
  });

  it.each(['connect', 'BEGIN', 'COMMIT'])('a failed %s still ends the client', async (step) => {
    m.failOn = step;
    await expect(inRequest(() => withOwnPlatformAdminTx(async () => 1))).rejects.toThrow(/failed|refused/);
    expect(last().ended).toBe(1);
  });

  it("listens for 'error' before connecting: a socket error is logged, not thrown", async () => {
    await inRequest(() => withOwnPlatformAdminTx(async () => {
      expect(() => last().emit('error', new Error('socket reset'))).not.toThrow();
    }));
    expect(last().errorListenersAtConnect).toBeGreaterThan(0);
    expect(m.logError).toHaveBeenCalledWith('withOwnPlatformAdminTx: connection error', { message: 'socket reset' }, 'Auth');
  });
});

describe('registerImpersonationSession (the same one-off client gap)', () => {
  const input = { sessionId: 's-1', actorUserId: 'a-1', targetUserId: 't-1' };

  it("listens for 'error' before connecting, and a socket error is logged, not thrown", async () => {
    await registerImpersonationSession(input);
    expect(last().errorListenersAtConnect).toBeGreaterThan(0);
    expect(() => last().emit('error', new Error('socket reset'))).not.toThrow();
    expect(m.logError).toHaveBeenCalledWith('registerImpersonationSession: connection error', { message: 'socket reset' }, 'Auth');
  });

  it('a failed connect still ends the client', async () => {
    m.failOn = 'connect';
    await expect(registerImpersonationSession(input)).rejects.toThrow('connect refused');
    expect(last().ended).toBe(1);
  });
});
