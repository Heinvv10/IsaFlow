/**
 * Round 26 on withToolSession (mocked pool and registry, no database): the connect is bounded and watched (B26-1), a lost connection
 * fails every later query at once (B26-2), a read timeout in the dry run says its writes may be held (R26-1), a statement timeout is
 * named (B26-4), and the "never silent" wiring is pinned (R26-3): the session's own notices, its timers, the holder of a lock timeout.
 * Split from sageToolSessionWaits (R25-7), which it shares its mocks with:
 *   - B24-2: lock_timeout, and a write tool's idempotency key taken without waiting (BatchKeyHeldError, worded by phase: R25-2);
 *   - R24-5 / R25-6: a dry run whose ROLLBACK is not confirmed after its own error says its writes may be held, only once its work ran;
 *   - round 25: statement_timeout; a client query_timeout is a loss (before the COMMIT: nothing written; at it: unconfirmed); a lock
 *     timeout (55P03) in a committing request stops it (LockWaitError), in the dry run it is reported to the runner (session.stall).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const registry = vi.hoisted(() => ({ call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>() }));
const member = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }, { name: 'pu', write: true, perUserIdempotency: true }], call: registry.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({ getCompanyMembership: async () => ({ rows: member.ok ? [{ account_user_id: 'u1', role: 'owner' }] : [] }) }));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
const als = vi.hoisted(() => ({ ctx: null as null | { client: { query: (t: string) => Promise<unknown> } } }));
// The request context a tool reads its client from (ALS): the session's watched view of the connection.
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (ctx: never, fn: () => unknown) => { als.ctx = ctx; return fn(); }, drainAfterCommit: () => undefined, settleAfterRollback: () => undefined }));
/** A query as a tool issues it: through the request context's client. */
const toolQuery = (text: string) => als.ctx!.client.query(text);
vi.mock('@/lib/rollbackFailed', () => {
  const rollbackError = async (c: { query: (t: string) => Promise<unknown> }) => c.query('ROLLBACK').then(() => null, (e: unknown) => e as Error);
  return { rollbackError, rollbackFailed: async (c: { query: (t: string) => Promise<unknown> }) => (await rollbackError(c)) !== null };
});

import { EventEmitter } from 'node:events';
import { ConnectionLostError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError, StatementTimeoutError, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

const sent: string[] = [];
const pool = { connect: async () => Object.assign(new EventEmitter(), { query: async (text: string) => { sent.push(text); return { rows: [] }; }, release: () => undefined }) } as never;
const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
/** A client whose queries are answered by `answer` (a rejection is thrown), recording each text. */
const clientOf = (answer: (text: string) => unknown, extra: Record<string, unknown> = {}) => {
  const texts: string[] = [];
  const client = Object.assign(new EventEmitter(), { ...extra, texts, release: vi.fn(), query: async (text: string) => { texts.push(text); const a = answer(text); if (a instanceof Error) throw a; return a ?? { rows: [] }; } });
  return client;
};
const poolOf = (client: unknown) => ({ connect: async () => client }) as never;

beforeEach(() => { sent.length = 0; registry.call.mockReset(); member.ok = true; });
afterEach(() => { vi.useRealTimers(); });

describe('B26-1: the connect is bounded and watched', () => {
  const noConnect = () => ({ connect: async () => { throw new Error('timeout exceeded when trying to connect'); } }) as never;
  it('a connect that fails in a request that commits nothing: ConnectionLostError, nothing sent', async () => {
    const err = await withToolSession(noConnect(), 'c1', 'u1', false, async () => 'r').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect((err as Error).message).toBe('no connection to the database could be had (timeout exceeded when trying to connect): nothing was sent, so nothing of it was written');
  });
  it('in a committing request: a loss before the COMMIT was sent (the batch failed, nothing written)', async () => {
    expect(await withToolSession(noConnect(), 'c1', 'u1', true, async () => 'r').then(() => null, (e: unknown) => e)).toBeInstanceOf(LostBeforeCommitError);
  });
  it('a connect that waits is said; no timer is left after it, nor after a normal request (R26-3)', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let open: (c: unknown) => void = () => undefined;
    const slow = { connect: () => new Promise((r) => { open = r; }) } as never;
    const done = withToolSession(slow, 'c1', 'u1', false, async () => 'r', { onNotice: (l) => lines.push(l) });
    await vi.advanceTimersByTimeAsync(5_600);
    expect(lines).toEqual(['a database request has had no answer for 5 s']);
    open(clientOf(() => undefined));
    expect(await done).toBe('r');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('R26-3: a query that waits is said; settling it starts over; no timer outlives the request', () => {
  it('a query pending past 5 s calls onNotice; the next query starts over; the throw path leaves no timer', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let answer: () => void = () => undefined;
    const client = clientOf((t) => (t === 'SELECT slow' ? new Promise<{ rows: [] }>((r) => { answer = () => r({ rows: [] }); }) : undefined));
    const done = withToolSession(poolOf(client), 'c1', 'u1', false, async () => {
      const slow = toolQuery('SELECT slow');
      await vi.advanceTimersByTimeAsync(5_600);
      expect(lines).toEqual(['a database request has had no answer for 5 s']);
      answer();
      await slow;
      await vi.advanceTimersByTimeAsync(5_600); // nothing in flight: no notice
      expect(lines).toHaveLength(1);
      throw new Error('the work failed');
    }, { onNotice: (l) => lines.push(l) }).then(() => null, (e: unknown) => e);
    expect(String(await done)).toBe('Error: the work failed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a lock timeout after a blocker was sampled: LockWaitError names THAT holder, with its state', async () => {
    const client = clientOf((t) => (t === 'SELECT take_number_lock'
      ? new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })), 1_700))
      : undefined), { processID: 41 });
    const sampler = vi.fn(async () => ({ rows: [{ pid: 888, state: 'idle in transaction', app: 'sage-migration' }] }));
    const pool = { connect: async () => client, query: sampler } as never;
    let seen: Error | null = null;
    await withToolSession(pool, 'c1', 'u1', false, async (s) => { await toolQuery('SELECT take_number_lock').catch(() => undefined); seen = s.stall!(); });
    expect(seen).toBeInstanceOf(LockWaitError);
    expect((seen as unknown as LockWaitError).holder).toEqual({ pid: 888, state: 'idle in transaction', app: 'sage-migration' });
    expect(sampler).toHaveBeenCalledWith(expect.stringContaining('pg_blocking_pids($1)'), [41]);
  });
});

describe('B26-2: once the connection is lost, every later query fails at once with that loss', () => {
  it('after a read timeout nothing more is sent to the stuck connection', async () => {
    const client = clientOf((t) => (t === 'SELECT stuck' ? new Error('Query read timeout') : undefined));
    const later: unknown[] = [];
    await withToolSession(poolOf(client), 'c1', 'u1', true, async () => {
      await toolQuery('SELECT stuck').catch(() => undefined);
      later.push(await toolQuery('ROLLBACK TO SAVEPOINT x').then(() => 'answered', (e: unknown) => e));
      return 'r';
    }).catch(() => undefined);
    expect(String(later[0])).toBe('Error: Query read timeout');
    expect(client.texts).not.toContain('ROLLBACK TO SAVEPOINT x');
  });
});

describe('R26-1: a read timeout in the DRY run (it wrote) with a ROLLBACK not confirmed', () => {
  const stuck = (extra = {}) => clientOf((t) => (t === 'SELECT stuck' ? new Error('Query read timeout') : t === 'ROLLBACK' ? new Error('ROLLBACK did not answer within 5000ms') : undefined), extra);
  it('says its writes may still be held, with its pid and the remedy, never "the server rolled it back"', async () => {
    const err = await withToolSession(poolOf(stuck({ processID: 63 })), 'c1', 'u1', false, async () => { await toolQuery('SELECT stuck').catch(() => undefined); return 'r'; }, { wrote: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DryRollbackUnconfirmedError);
    expect((err as Error).message).toBe("Query read timeout; and the dry run's ROLLBACK was not confirmed (ROLLBACK did not answer within 5000ms); its writes may still be held (backend pid 63: wait for the server to end it, or SELECT pg_terminate_backend(63))");
  });
  it('the same thrown out of the work: the same', async () => {
    const err = await withToolSession(poolOf(stuck({ processID: 63 })), 'c1', 'u1', false, async () => { await toolQuery('SELECT stuck'); }, { wrote: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DryRollbackUnconfirmedError);
  });
  it('a plain read (it wrote nothing): ConnectionLostError, as before', async () => {
    expect(await withToolSession(poolOf(stuck()), 'c1', 'u1', false, async () => { await toolQuery('SELECT stuck').catch(() => undefined); }).then(() => null, (e: unknown) => e)).toBeInstanceOf(ConnectionLostError);
  });
});

describe('B26-4: a statement timeout (57014) is named and stops the run', () => {
  const timedOut = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  it('in a committing request: StatementTimeoutError, no COMMIT sent', async () => {
    const client = clientOf((t) => (t === 'INSERT slow' ? timedOut() : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, async () => { await toolQuery('INSERT slow').catch(() => undefined); return 'r'; }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StatementTimeoutError);
    expect((err as Error).message).toBe("a statement ran past the migration's 60 s statement_timeout (canceling statement due to statement timeout); nothing of it was written: the database is overloaded or stalled; re-run once it answers");
    expect(client.texts).not.toContain('COMMIT');
  });
  it('in the dry run: stall() reports it; a cancel by a person (57014 "user request") is not it', async () => {
    let seen: Error | null = null;
    await withToolSession(poolOf(clientOf((t) => (t === 'INSERT slow' ? timedOut() : undefined))), 'c1', 'u1', false, async (s) => { await toolQuery('INSERT slow').catch(() => undefined); seen = s.stall!(); });
    expect(seen).toBeInstanceOf(StatementTimeoutError);
    const cancel = Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
    await withToolSession(poolOf(clientOf((t) => (t === 'INSERT slow' ? cancel : undefined))), 'c1', 'u1', false, async (s) => { await toolQuery('INSERT slow').catch(() => undefined); seen = s.stall!(); });
    expect(seen).toBeNull();
  });
});
