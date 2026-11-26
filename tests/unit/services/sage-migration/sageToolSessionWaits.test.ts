/**
 * withToolSession's waits and locks, with a mocked pool and registry (no database), split from sageToolSessionCall (R25-7):
 *   - B24-2: lock_timeout, and a write tool's idempotency key taken without waiting (BatchKeyHeldError, worded by phase: R25-2);
 *   - R24-5 / R25-6: a dry run whose ROLLBACK is not confirmed after its own error says its writes may be held, only once its work ran;
 *   - round 25: statement_timeout; a client query_timeout is a loss (before the COMMIT: nothing written; at it: unconfirmed); a lock
 *     timeout (55P03) in a committing request stops it (LockWaitError), in the dry run it is reported to the runner (session.stall).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { BatchKeyHeldError, CommitUnconfirmedError, ConnectionLostError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError, NotAMemberError, SAGE_LOCK_TIMEOUT_MS,
  SAGE_STATEMENT_TIMEOUT_MS, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

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

describe('B24-2: a lock another session holds never hangs a migration request', () => {
  it('every request sets a lock_timeout (SAGE_LOCK_TIMEOUT_MS) in its own transaction', async () => {
    registry.call.mockResolvedValueOnce(ok('{"created":1}'));
    await withToolSession(pool, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));
    expect(sent).toContain(`SET LOCAL lock_timeout = '${SAGE_LOCK_TIMEOUT_MS}ms'`);
    expect(SAGE_LOCK_TIMEOUT_MS).toBe(10_000);
  });
  it('a write tool\'s idempotency key held by another session: BatchKeyHeldError at once, naming its pid; the tool never runs', async () => {
    const queries: Array<[string, unknown[] | undefined]> = [];
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string, values?: unknown[]) => {
        queries.push([text, values]);
        if (text.startsWith('SELECT pg_try_advisory_xact_lock')) return { rows: [{ ok: false }] };
        if (text.includes('FROM pg_locks')) return { rows: [{ pid: 777, state: 'idle in transaction', app: 'sage-migration' }] };
        return { rows: [] };
      },
      release: vi.fn(),
    });
    registry.call.mockClear();
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, (s) => s.call('w', { idempotency_key: 'batch-1' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BatchKeyHeldError);
    expect((err as Error).message).toBe("another session holds this batch's lock: likely a previous run's dry transaction (backend pid 777, idle in transaction: a transaction left open; wait for the server to end it, or SELECT pg_terminate_backend(777)); then re-run");
    expect(registry.call).not.toHaveBeenCalled();
    // the key text the registry locks (src/lib/mcp/audit.ts acquireIdempotencyLock)
    expect(queries.find(([t]) => t.startsWith('SELECT pg_try_advisory_xact_lock'))?.[1]).toEqual(['mcp:c1:w:batch-1']);
  });
  it('a key that is free: the tool runs (the lock is this transaction\'s)', async () => {
    const client = Object.assign(new EventEmitter(), { query: async (text: string) => (text.startsWith('SELECT pg_try_advisory_xact_lock') ? { rows: [{ ok: true }] } : { rows: [] }), release: vi.fn() });
    registry.call.mockResolvedValueOnce(ok('{"created":1}'));
    expect(await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, (s) => s.call('w', { idempotency_key: 'k' }))).toMatchObject({ isError: false });
  });
});

describe('R24-5: a dry run that ends on an error and whose ROLLBACK is then not confirmed', () => {
  it('still says its writes may be held, after the error it ended with (which stays its cause chain\'s first line)', async () => {
    const client = Object.assign(new EventEmitter(), { processID: 99, query: async (text: string) => { if (text === 'ROLLBACK') throw new Error('ROLLBACK did not answer within 5000ms'); return { rows: [] }; }, release: vi.fn() });
    const stop = new Error('stopped by SIGTERM: no further batch is sent; nothing was written to the books');
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => { throw stop; }, { wrote: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DryRollbackUnconfirmedError);
    expect((err as DryRollbackUnconfirmedError).after).toBe(stop);
    expect((err as Error).message).toBe("stopped by SIGTERM: no further batch is sent; nothing was written to the books; and the dry run's ROLLBACK was not confirmed (ROLLBACK did not answer within 5000ms); its writes may still be held (backend pid 99: wait for the server to end it, or SELECT pg_terminate_backend(99))");
  });
  it('a plain read that ends on an error: the error as it is', async () => {
    const client = Object.assign(new EventEmitter(), { query: async (text: string) => { if (text === 'ROLLBACK') throw new Error('ROLLBACK did not answer within 5000ms'); return { rows: [] }; }, release: vi.fn() });
    const bug = new Error('a bug');
    expect(await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => { throw bug; }).then(() => null, (e: unknown) => e)).toBe(bug);
  });
});


describe('round 25: no statement waits forever', () => {
  it('every request also sets statement_timeout, above the lock timeout', async () => {
    registry.call.mockResolvedValueOnce(ok('{"created":1}'));
    await withToolSession(pool, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));
    expect(sent).toContain(`SET LOCAL statement_timeout = '${SAGE_STATEMENT_TIMEOUT_MS}ms'`);
    expect(SAGE_STATEMENT_TIMEOUT_MS).toBeGreaterThan(SAGE_LOCK_TIMEOUT_MS);
  });
  const readTimeout = () => new Error('Query read timeout');
  it('a client query_timeout in a committing request: a loss seen before the COMMIT (nothing written; no COMMIT sent; released broken)', async () => {
    const client = clientOf((t) => (t === 'SELECT stuck' ? readTimeout() : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, async () => { await toolQuery('SELECT stuck').catch(() => undefined); return 'r'; }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LostBeforeCommitError);
    expect((err as Error).message).toMatch(/before its COMMIT was sent \(Query read timeout\); nothing of it was written/);
    expect(client.texts).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it('a client query_timeout on the COMMIT itself: unconfirmed (it may have landed)', async () => {
    const client = clientOf((t) => (t === 'COMMIT' ? readTimeout() : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, async () => 'r').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommitUnconfirmedError);
  });
  it('a client query_timeout in a request that commits nothing: ConnectionLostError', async () => {
    const client = clientOf((t) => (t === 'SELECT stuck' ? readTimeout() : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', false, async () => { await toolQuery('SELECT stuck').catch(() => undefined); return 'r'; }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionLostError);
  });
  const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  it('R25-3: a lock timeout inside a committing request (its tool answered a failure): LockWaitError, worded live, no COMMIT sent', async () => {
    const client = clientOf((t) => (t === 'SELECT take_number_lock' ? lockTimeout() : undefined));
    registry.call.mockImplementationOnce(async () => { await toolQuery('SELECT take_number_lock').catch(() => undefined); return { content: [{ type: 'text', text: 'retry in a moment' }], isError: true }; });
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LockWaitError);
    expect((err as LockWaitError).phase).toBe('live');
    expect((err as Error).message).toBe('a lock it needs is held by another session and the wait timed out (canceling statement due to lock timeout); nothing of it was written (held by backend pid unknown: wait for it to end); then re-run');
    expect(client.texts).not.toContain('COMMIT');
  });
  it('a lock timeout in the dry run: the request ends normally, and session.stall() says it (worded dry), for the runner to stop', async () => {
    const client = clientOf((t) => (t === 'SELECT take_number_lock' ? lockTimeout() : undefined));
    registry.call.mockImplementationOnce(async () => { await toolQuery('SELECT take_number_lock').catch(() => undefined); return { content: [{ type: 'text', text: 'retry' }], isError: true }; });
    let seen: Error | null = null;
    await withToolSession(poolOf(client), 'c1', 'u1', false, async (s) => { await s.call('w', { idempotency_key: 'k' }); seen = s.stall!(); });
    expect(seen).toBeInstanceOf(LockWaitError);
    expect(seen!.message).toMatch(/\(held by backend pid unknown: wait for it to end\); then re-run$/);
  });
  it('a request with no lock timeout: stall() is null; the client itself is never patched (a pool may hand out wrapped clients)', async () => {
    const client = clientOf(() => undefined);
    const own = client.query;
    let seen: unknown = 'unset';
    await withToolSession(poolOf(client), 'c1', 'u1', false, async (s) => { seen = s.stall!(); });
    expect(seen).toBeNull();
    expect(client.query).toBe(own);
  });
});

describe('a pool that hands out wrapped clients (as the integration fixtures do)', () => {
  it('works through the session\'s view, with no recursion, and the wrapper sees every query', async () => {
    const inner = clientOf(() => undefined);
    const seenByWrapper: string[] = [];
    const wrapped = new Proxy(inner, { get(t, prop) {
      if (prop === 'query') return (text: string) => { seenByWrapper.push(text); return (t.query as (x: string) => Promise<unknown>)(text); };
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    registry.call.mockResolvedValueOnce(ok('{"created":1}'));
    expect(await withToolSession(poolOf(wrapped), 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }))).toMatchObject({ isError: false });
    expect(seenByWrapper).toContain('COMMIT');
  });
});

describe('R25-2 / R25-8: the key lock, by phase, by the registry\'s text', () => {
  it('a held LIVE key: no "terminate" advice; it may be mid-COMMIT', async () => {
    const client = clientOf((t) => (t.startsWith('SELECT pg_try_advisory_xact_lock') ? { rows: [{ ok: false }] } : t.includes('FROM pg_locks') ? { rows: [{ pid: 31 }] } : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BatchKeyHeldError);
    expect((err as Error).message).toBe("another session holds this batch's lock: likely a previous run's live transaction whose COMMIT was not confirmed, or another client using the same key (backend pid 31); it may be committing, so do not terminate it blind: check the books, wait for it to end, then re-run");
  });
  it('the key is trimmed, and a per-user tool\'s is namespaced by the caller, as the registry does', async () => {
    const values: unknown[] = [];
    const client = clientOf((t) => (t.startsWith('SELECT pg_try_advisory_xact_lock') ? { rows: [{ ok: true }] } : undefined));
    const q = client.query;
    client.query = (async (t: string, v?: unknown[]) => { if (t.startsWith('SELECT pg_try_advisory_xact_lock')) values.push(v![0]); return q(t); }) as typeof q;
    registry.call.mockResolvedValue(ok('{"created":1}'));
    await withToolSession(poolOf(client), 'c1', 'u1', false, async (s) => { await s.call('w', { idempotency_key: '  k1  ' }); await s.call('pu', { idempotency_key: 'k2' }); });
    expect(values).toEqual(['mcp:c1:w:k1', 'mcp:c1:pu:u:u1:k2']);
  });
});

describe('R25-6: an error before the request\'s work ran', () => {
  it('a refused membership with a ROLLBACK that fails: the refusal as it is, never "writes may still be held"', async () => {
    member.ok = false;
    const client = clientOf((t) => (t === 'ROLLBACK' ? new Error('ROLLBACK did not answer within 5000ms') : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', false, async () => 'r', { wrote: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NotAMemberError);
  });
});
