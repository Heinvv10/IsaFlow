/**
 * R27-1 on withToolSession (mocked pool and registry, the REAL rollbackError): a stall (57014, 55P03) raised by a statement OUTSIDE the
 * tool's savepoint makes the call, or the request, reject; it is said as the stall, whatever statement raised it, so the live run stops
 * (exit 4) and the dry run stops at that batch:
 *   - registry.call rejects with the 57014 its bookkeeping got (findIdempotentReplay, moduleFenceRefusal, acquireIdempotencyLock);
 *   - the membership query, the first statement after BEGIN, rejects with it;
 *   - a 55P03 from the registry's own lock wait: LockWaitError.
 * The one 57014 that is not a stall is the session's own: rollbackError cancels the backend when the request's ROLLBACK does not answer.
 * R27-8: a live loss by a client read timeout says its backend may still hold the locks and the key, with its pid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const registry = vi.hoisted(() => ({ call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>() }));
const member = vi.hoisted(() => ({ viaQuery: false }));
const cancel = vi.hoisted(() => ({ onCancel: null as null | (() => void) }));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }], call: registry.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({
  getCompanyMembership: async (db: { query: (t: string) => Promise<unknown> }) => {
    if (member.viaQuery) await db.query('SELECT membership');
    return { rows: [{ account_user_id: 'u1', role: 'owner' }] };
  },
}));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
const als = vi.hoisted(() => ({ ctx: null as null | { client: { query: (t: string) => Promise<unknown> } } }));
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (ctx: never, fn: () => unknown) => { als.ctx = ctx; return fn(); }, drainAfterCommit: () => undefined, settleAfterRollback: () => undefined }));
vi.mock('@/lib/cancelBackend', () => ({ cancelBackend: () => { cancel.onCancel?.(); return true; } }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { EventEmitter } from 'node:events';
import pg from 'pg';
import { setRollbackBoundForTests } from '@/lib/rollbackFailed';
import { CommitRefusedError, CommitUnconfirmedError, LockWaitError, LostBeforeCommitError, StatementTimeoutError, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

const toolQuery = (text: string) => als.ctx!.client.query(text);
const clientOf = (answer: (text: string) => unknown) => {
  const texts: string[] = [];
  return Object.assign(new EventEmitter(), { processID: 51, texts, release: vi.fn(), query: async (text: string) => { texts.push(text); const a = await answer(text); if (a instanceof Error) throw a; return a ?? { rows: [] }; } });
};
const poolOf = (client: unknown) => ({ connect: async () => client }) as never;
/** A server's ErrorResponse, as pg gives it (a DatabaseError). */
const pgError = (code: string, text: string) => Object.assign(new pg.DatabaseError(text, 0, 'error'), { code, severity: 'ERROR' });
/** Rejects with `err` after `ms` of fake time. */
const after = (ms: number, err: Error) => new Promise((_, reject) => setTimeout(() => reject(err), ms));
const settle = async <T,>(p: Promise<T>, ms: number) => { await vi.advanceTimersByTimeAsync(ms); return p; };

beforeEach(() => { registry.call.mockReset(); member.viaQuery = false; cancel.onCancel = null; });
afterEach(() => { vi.useRealTimers(); });

describe('R27-1: registry.call rejects with the stall its bookkeeping got', () => {
  const bookkeeping = (err: () => Error, ms: number) => {
    const client = clientOf((t) => (t === 'SELECT find_replay' ? after(ms, err()) : undefined));
    registry.call.mockImplementation(async () => { await toolQuery('SELECT find_replay'); return { content: [{ type: 'text', text: '{}' }] }; });
    return client;
  };
  it('live: StatementTimeoutError (the run stops, exit 4), no COMMIT sent', async () => {
    vi.useFakeTimers();
    const client = bookkeeping(() => pgError('57014', 'storniere Anfrage wegen Zeitüberschreitung der Anfrage'), 60_000);
    const err = await settle(withToolSession(poolOf(client), 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e), 60_000);
    expect(err).toBeInstanceOf(StatementTimeoutError);
    expect((err as Error).message).toMatch(/^a statement ran past the migration's 60 s statement_timeout/);
    expect(client.texts).not.toContain('COMMIT');
  });
  it('dry: the call itself rejects with the StatementTimeoutError (the dry run stops at this batch)', async () => {
    vi.useFakeTimers();
    const client = bookkeeping(() => pgError('57014', 'canceling statement due to statement timeout'), 60_000);
    let fromCall: unknown = null;
    await settle(withToolSession(poolOf(client), 'c1', 'u1', false, async (s) => { fromCall = await s.call('w', { idempotency_key: 'k' }).then(() => null, (e: unknown) => e); }, { wrote: true }), 60_000);
    expect(fromCall).toBeInstanceOf(StatementTimeoutError);
    expect((fromCall as StatementTimeoutError).phase).toBe('dry');
  });
  it('a 55P03 from the registry\'s own lock wait: LockWaitError, live', async () => {
    const client = bookkeeping(() => pgError('55P03', 'konnte Sperre nicht setzen'), 0);
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LockWaitError);
    expect(client.texts).not.toContain('COMMIT');
  });
});

describe('R27-1: the membership query (the first statement after BEGIN) rejects with a 57014', () => {
  for (const commit of [true, false]) {
    it(`${commit ? 'live' : 'dry'}: StatementTimeoutError, the work never run`, async () => {
      vi.useFakeTimers();
      member.viaQuery = true;
      const client = clientOf((t) => (t === 'SELECT membership' ? after(60_000, pgError('57014', 'canceling statement due to statement timeout')) : undefined));
      const work = vi.fn(async () => 'r');
      const err = await settle(withToolSession(poolOf(client), 'c1', 'u1', commit, work).then(() => null, (e: unknown) => e), 60_000);
      expect(err).toBeInstanceOf(StatementTimeoutError);
      expect(work).not.toHaveBeenCalled();
    });
  }
});

describe("R27-1: the session's own cancel is not a stall", () => {
  it('a query the request left in flight, cancelled by rollbackError when its ROLLBACK did not answer: no stall recorded', async () => {
    const restore = setRollbackBoundForTests(30);
    try {
      let rejectPending: (e: Error) => void = () => undefined;
      cancel.onCancel = () => rejectPending(pgError('57014', 'canceling statement due to user request'));
      const client = clientOf((t) => (t === 'SELECT pending' ? new Promise((_, reject) => { rejectPending = reject; })
        : t === 'ROLLBACK' ? new Promise(() => undefined) : undefined));
      let stall: (() => unknown) | undefined;
      const r = await withToolSession(poolOf(client), 'c1', 'u1', false, async (s) => { stall = s.stall; void toolQuery('SELECT pending').catch(() => undefined); return 'r'; });
      await new Promise((res) => setImmediate(res));
      expect(r).toBe('r'); // a plain read: what it read stands (R22-1)
      expect(stall!()).toBeNull();
    } finally { restore(); }
  });
});

describe('R27-8: a live loss by a client read timeout, before the COMMIT', () => {
  it('nothing written; its backend may still hold the locks and the batch key, with its pid', async () => {
    const client = clientOf((t) => (t === 'SELECT stuck' ? new Error('Query read timeout') : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, async () => { await toolQuery('SELECT stuck').catch(() => undefined); return 'r'; }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LostBeforeCommitError);
    expect((err as LostBeforeCommitError).heldBy).toEqual({ pid: 51 });
    expect((err as Error).message).toBe("the connection was lost before its COMMIT was sent (Query read timeout); nothing of it was written; its backend may still hold the request's locks and the batch's key (backend pid 51, this run's own: SELECT pg_terminate_backend(51) ends it)");
  });
  it('the same thrown out of the work', async () => {
    const client = clientOf((t) => (t === 'SELECT stuck' ? new Error('Query read timeout') : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, async () => { await toolQuery('SELECT stuck'); }).then(() => null, (e: unknown) => e);
    expect((err as LostBeforeCommitError).heldBy).toEqual({ pid: 51 });
  });
});

describe('R28-8 / B28-2: a 57014 raised BY the COMMIT of a live request', () => {
  for (const [what, text] of [['English', 'canceling statement due to user request'], ['German', 'storniere Anfrage wegen Benutzeraufforderung']] as const) {
    it(`(${what}) is a refusal, rolled back: CommitRefusedError, never a stall or "nothing written" before it, never unconfirmed`, async () => {
      registry.call.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"created":1}' }] });
      const client = clientOf((t) => (t === 'COMMIT' ? pgError('57014', text) : undefined));
      const err = await withToolSession(poolOf(client), 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CommitRefusedError);
      expect(err).not.toBeInstanceOf(StatementTimeoutError);
      expect(err).not.toBeInstanceOf(CommitUnconfirmedError);
      expect((err as Error).message).toBe(`the server refused the COMMIT (57014: ${text}): the transaction was rolled back, nothing of it was written`);
    });
  }
  it('a COMMIT that never answered stays unconfirmed (it may still land)', async () => {
    registry.call.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"created":1}' }] });
    const client = clientOf((t) => (t === 'COMMIT' ? new Error('COMMIT did not answer within 70000ms') : undefined));
    const err = await withToolSession(poolOf(client), 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommitUnconfirmedError);
  });
});
