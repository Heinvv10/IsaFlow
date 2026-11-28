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
// The REAL rollbackError (R27-9): its 5 s bound and its cancel of the backend are part of what is held here (sageToolSessionCancels).
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

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
    expect((seen as unknown as LockWaitError).holder).toMatchObject({ pid: 888, state: 'idle in transaction', app: 'sage-migration', ageS: null, idleMs: null });
    expect(sampler).toHaveBeenCalledWith(expect.stringContaining('pg_blocking_pids($1)'), [41]);
  });
});

describe('R28 (round23 B25-1 under load): a sample that answers after the server cancelled the wait finds nothing', () => {
  it('the lock timeout still names the holder last seen in this wait', async () => {
    const client = clientOf((t) => (t === 'SELECT take_number_lock'
      ? new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })), 2_700))
      : undefined), { processID: 41 });
    const rows = [[{ pid: 888, state: 'idle in transaction', app: 'x' }], []];
    const pool = { connect: async () => client, query: vi.fn(async () => ({ rows: rows.length > 1 ? rows.shift()! : rows[0]! })) } as never;
    let seen: Error | null = null;
    await withToolSession(pool, 'c1', 'u1', false, async (s) => { await toolQuery('SELECT take_number_lock').catch(() => undefined); seen = s.stall!(); });
    expect(seen).toBeInstanceOf(LockWaitError);
    expect((seen as unknown as LockWaitError).holder?.pid).toBe(888);
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
    expect((err as Error).message).toBe("Query read timeout; and the dry run's ROLLBACK was not confirmed (ROLLBACK did not answer within 5000ms); its writes may still be held (backend pid 63, this run's own: SELECT pg_terminate_backend(63) ends it); the dry run commits nothing, so nothing was written to the books; the live run was not started");
  });
  it('the same thrown out of the work: the same', async () => {
    const err = await withToolSession(poolOf(stuck({ processID: 63 })), 'c1', 'u1', false, async () => { await toolQuery('SELECT stuck'); }, { wrote: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DryRollbackUnconfirmedError);
  });
  it('a plain read (it wrote nothing): ConnectionLostError, as before', async () => {
    expect(await withToolSession(poolOf(stuck()), 'c1', 'u1', false, async () => { await toolQuery('SELECT stuck').catch(() => undefined); }).then(() => null, (e: unknown) => e)).toBeInstanceOf(ConnectionLostError);
  });
});

describe('B26-4 / R27-1: a 57014 is a stall, told by its SQLSTATE and how long it ran, never by its message', () => {
  /** A statement the server cancels with 57014 after `ms` (fake time), with the server's message `text`. */
  const cancelledAfter = (ms: number, text: string) => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(text), { code: '57014' })), ms));
  it('in a committing request, past the statement_timeout: StatementTimeoutError, no COMMIT sent', async () => {
    vi.useFakeTimers();
    const client = clientOf((t) => (t === 'INSERT slow' ? cancelledAfter(60_000, 'canceling statement due to statement timeout') : undefined));
    const done = withToolSession(poolOf(client), 'c1', 'u1', true, async () => { await toolQuery('INSERT slow').catch(() => undefined); return 'r'; }).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await done;
    expect(err).toBeInstanceOf(StatementTimeoutError);
    expect((err as Error).message).toBe("a statement ran past the migration's 60 s statement_timeout (canceling statement due to statement timeout); nothing of it was written: the database is overloaded or stalled; re-run once it answers");
    expect(client.texts).not.toContain('COMMIT');
  });
  it('a German server message (B27-2): the same stall, in the dry run', async () => {
    vi.useFakeTimers();
    let seen: Error | null = null;
    const client = clientOf((t) => (t === 'INSERT slow' ? cancelledAfter(60_000, 'storniere Anfrage wegen Zeitüberschreitung der Anfrage') : undefined));
    const done = withToolSession(poolOf(client), 'c1', 'u1', false, async (s) => { await toolQuery('INSERT slow').catch(() => undefined); seen = s.stall!(); });
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(seen).toBeInstanceOf(StatementTimeoutError);
    expect((seen as unknown as Error).message).toMatch(/^a statement ran past the migration's 60 s statement_timeout \(storniere Anfrage/);
  });
  it('one cancelled sooner (pg_cancel_backend by another session): a stall too, said as a cancel, in any language', async () => {
    let seen: Error | null = null;
    const cancel = Object.assign(new Error('storniere Anfrage wegen Benutzeraufforderung'), { code: '57014' });
    await withToolSession(poolOf(clientOf((t) => (t === 'INSERT slow' ? cancel : undefined))), 'c1', 'u1', false, async (s) => { await toolQuery('INSERT slow').catch(() => undefined); seen = s.stall!(); });
    expect(seen).toBeInstanceOf(StatementTimeoutError);
    expect((seen as unknown as Error).message).toMatch(/^a statement was cancelled after 0 s, before the migration's 60 s statement_timeout \(57014: storniere Anfrage wegen Benutzeraufforderung\): another session cancelled it/);
  });
});
