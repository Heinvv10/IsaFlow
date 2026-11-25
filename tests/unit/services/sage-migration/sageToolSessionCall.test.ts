/**
 * Round-13 review R3: withToolSession's call path, with a mocked pool and registry (no database).
 *   (a) a call the registry answers from a STORED answer (ctx.onIdempotentReplay) comes back `replayed`; the hook is per call;
 *   (b) a SUCCESS that is not JSON throws inside a committed request, which then rolls back (no COMMIT); a dry run gets it as a failure;
 *   (c) B19-1: the client's 'error' event is listened to while checked out (removed after), and a COMMIT that fails after it is
 *       CommitUnconfirmedError with connectionLost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const registry = vi.hoisted(() => ({ call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>() }));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }], call: registry.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({ getCompanyMembership: async () => ({ rows: [{ account_user_id: 'u1', role: 'owner' }] }) }));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (_ctx: unknown, fn: () => unknown) => fn(), drainAfterCommit: () => undefined, settleAfterRollback: () => undefined }));
// The real semantics: a ROLLBACK that fails is swallowed and reported (true: the connection is unusable).
vi.mock('@/lib/rollbackFailed', () => ({ rollbackFailed: async (c: { query: (t: string) => Promise<unknown> }) => c.query('ROLLBACK').then(() => false, () => true) }));

import { EventEmitter } from 'node:events';
import { CommitUnconfirmedError, ConnectionLostError, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

const sent: string[] = [];
const pool = { connect: async () => Object.assign(new EventEmitter(), { query: async (text: string) => { sent.push(text); return { rows: [] }; }, release: () => undefined }) } as never;
const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });

beforeEach(() => { sent.length = 0; registry.call.mockReset(); });

describe('(a) a stored answer is reported as replayed', () => {
  it('the call the registry replayed comes back replayed; the next call, run fresh, does not', async () => {
    registry.call
      .mockImplementationOnce(async (_n, _a, ctx) => { ctx.onIdempotentReplay?.(); return ok('{"created":0}'); })
      .mockImplementationOnce(async () => ok('{"created":1}'));
    const [first, second] = await withToolSession(pool, 'c1', 'u1', true, async (s) => [await s.call('w', { idempotency_key: 'k' }), await s.call('w', { idempotency_key: 'k2' })]);
    expect(first).toEqual({ isError: false, text: '{"created":0}', body: { created: 0 }, replayed: true });
    expect(second).toEqual({ isError: false, text: '{"created":1}', body: { created: 1 } });
    expect(sent).toContain('COMMIT');
  });
});

describe('(b) a success that is not JSON', () => {
  it('in a committed request: throws, and the request rolls back instead of committing what the tool wrote', async () => {
    registry.call.mockResolvedValueOnce(ok('<html>502 Bad Gateway</html>'));
    await expect(withToolSession(pool, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }))).rejects.toThrow(/not JSON/);
    expect(sent).toContain('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
  });
  it('in a dry run (rolled back anyway): returned as a failure, not thrown', async () => {
    registry.call.mockResolvedValueOnce(ok('<html>502 Bad Gateway</html>'));
    const r = await withToolSession(pool, 'c1', 'u1', false, (s) => s.call('w', { idempotency_key: 'k' }));
    expect(r.isError).toBe(true);
    expect(sent).not.toContain('COMMIT');
  });
  it('a refusal (isError) in a committed request is returned, and the request commits (the refusal\'s audit row)', async () => {
    registry.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'refused' }], isError: true });
    expect(await withToolSession(pool, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }))).toEqual({ isError: true, text: 'refused', body: null });
    expect(sent).toContain('COMMIT');
  });
});

describe('(c) B19-1: a connection lost while the client is checked out', () => {
  it('is no uncaught error; the failed COMMIT says connectionLost; the listener is gone after, and the client is released as broken', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string) => { sent.push(text); if (text === 'COMMIT') throw new Error('Client has encountered a connection error and is not queryable'); return { rows: [] }; },
      release: vi.fn(),
    });
    const lossPool = { connect: async () => client } as never;
    registry.call.mockImplementationOnce(async () => {
      client.emit('error', new Error('Connection terminated unexpectedly')); // throws if nobody listens
      return { content: [{ type: 'text', text: 'The operation failed.' }], isError: true };
    });
    const err = await withToolSession(lossPool, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommitUnconfirmedError);
    expect((err as CommitUnconfirmedError).connectionLost).toBe(true);
    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it('R20-2: a backend killed DURING the COMMIT (FATAL 57P01 rejects it before any client error): connectionLost', async () => {
    for (const fatal of [Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }), Object.assign(new Error('the database system is shutting down'), { code: '57P03' }),
      Object.assign(new Error('server closed the connection'), { code: '08006' }), new Error('Connection terminated unexpectedly')]) {
      const client = Object.assign(new EventEmitter(), {
        query: async (text: string) => { if (text === 'COMMIT') throw fatal; return { rows: [] }; },
        release: vi.fn(),
      });
      registry.call.mockResolvedValueOnce(ok('{"created":1}'));
      const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
      expect((err as CommitUnconfirmedError).connectionLost, fatal.message).toBe(true);
      expect(client.release, fatal.message).toHaveBeenCalledWith(true);
    }
  });
  it('a COMMIT that fails without a lost connection: connectionLost false', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string) => { if (text === 'COMMIT') throw new Error('COMMIT did not answer'); return { rows: [] }; },
      release: vi.fn(),
    });
    registry.call.mockResolvedValueOnce(ok('{"created":1}'));
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect((err as CommitUnconfirmedError).connectionLost).toBe(false);
  });
});

describe('(d) B20-1: a connection lost in a request that commits nothing (the dry run, the plan, a read)', () => {
  const lossClient = (commitQuery: (text: string) => Promise<unknown>) => Object.assign(new EventEmitter(), { query: commitQuery, release: vi.fn() });
  it('a loss the tool turned into a failed answer: ConnectionLostError (never a batch "failed"), released as broken', async () => {
    const client = lossClient(async () => ({ rows: [] }));
    registry.call.mockImplementationOnce(async () => {
      client.emit('error', new Error('Connection terminated unexpectedly'));
      return { content: [{ type: 'text', text: 'The operation failed.' }], isError: true };
    });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect((err as Error).message).toBe('the connection to the database was lost (Connection terminated unexpectedly) in a request that writes nothing (the dry run, the plan or a read of the books): that request wrote nothing');
    expect((err as Error & { cause?: unknown }).cause).toEqual(new Error('Connection terminated unexpectedly')); // R21-5
    expect((err as Error).name).toBe('ConnectionLostError');
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it('a query rejected by a terminated backend (57P01) inside the request: ConnectionLostError', async () => {
    const fatal = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    const client = lossClient(async (text: string) => { if (text.startsWith('SELECT snapshot')) throw fatal; return { rows: [] }; });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => { await client.query('SELECT snapshot'); }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect((err as Error).message).toMatch(/lost \(terminating connection due to administrator command\) in a request that writes nothing/);
  });
  it('any other failure of such a request is thrown as it is', async () => {
    const client = lossClient(async () => ({ rows: [] }));
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => { throw new Error('a plain bug'); }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(ConnectionLostError);
    expect((err as Error).message).toBe('a plain bug');
  });
});

/** R21-1: errors that are NOT a lost connection (a cancel/timeout, a constraint, a serialization failure, a refused or full server). */
const notLost = () => [
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
  Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
  Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' }),
  new Error('connect ECONNREFUSED 127.0.0.1:5432: connection refused'),
  Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
  Object.assign(new Error('feature not supported'), { code: '0A000' }), // class 0A, not 08
];

describe('R21-1: the classifier\'s negative side', () => {
  it('a COMMIT rejected for any of these is unconfirmed but NOT connectionLost', async () => {
    for (const e of notLost()) {
      const client = Object.assign(new EventEmitter(), { query: async (text: string) => { if (text === 'COMMIT') throw e; return { rows: [] }; }, release: vi.fn() });
      registry.call.mockResolvedValueOnce(ok('{"created":1}'));
      const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (x) => x.call('w', { idempotency_key: 'k' })).then(() => null, (r: unknown) => r);
      expect(err, e.message).toBeInstanceOf(CommitUnconfirmedError);
      expect((err as CommitUnconfirmedError).connectionLost, e.message).toBe(false);
    }
  });
  it('a request that commits nothing failing with any of these: thrown as it is, never ConnectionLostError', async () => {
    for (const e of notLost()) {
      const client = Object.assign(new EventEmitter(), { query: async () => ({ rows: [] }), release: vi.fn() });
      const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => { throw e; }).then(() => null, (r: unknown) => r);
      expect(err, e.message).toBe(e);
    }
  });
});

describe('R21-4: a null or undefined thrown', () => {
  it('is thrown as it is (the classifier does not replace it with a TypeError), on both paths', async () => {
    for (const thrown of [null, undefined]) {
      const client = Object.assign(new EventEmitter(), { query: async () => ({ rows: [] }), release: vi.fn() });
      const dry = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => { throw thrown; }).then(() => 'resolved', (r: unknown) => r);
      expect(dry).toBe(thrown);
      const committing = Object.assign(new EventEmitter(), { query: async (text: string) => { if (text === 'COMMIT') throw thrown; return { rows: [] }; }, release: vi.fn() });
      registry.call.mockResolvedValueOnce(ok('{"created":1}'));
      const err = await withToolSession({ connect: async () => committing } as never, 'c1', 'u1', true, (x) => x.call('w', { idempotency_key: 'k' })).then(() => null, (r: unknown) => r);
      expect((err as CommitUnconfirmedError).connectionLost).toBe(false);
    }
  });
});

describe('R21-2: a loss first seen during the dry request\'s own ROLLBACK', () => {
  it('is ConnectionLostError, not the failed answer blamed on the batch', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string) => {
        if (text === 'ROLLBACK') { client.emit('error', new Error('Connection terminated unexpectedly')); throw new Error('Connection terminated unexpectedly'); }
        return { rows: [] };
      },
      release: vi.fn(),
    });
    registry.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'The operation failed.' }], isError: true });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, (x) => x.call('w', { idempotency_key: 'k' })).then(() => null, (r: unknown) => r);
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it('a dry ROLLBACK that fails with no client error (the connection unusable) is a lost connection too; ROLLBACK sent once', async () => {
    const rollbacks: string[] = [];
    const client = Object.assign(new EventEmitter(), { query: async (text: string) => { if (text === 'ROLLBACK') { rollbacks.push(text); throw new Error('Client was closed'); } return { rows: [] }; }, release: vi.fn() });
    registry.call.mockResolvedValueOnce(ok('{"created":1}'));
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, (x) => x.call('w', { idempotency_key: 'k' })).then(() => null, (r: unknown) => r);
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect((err as Error).message).toMatch(/its ROLLBACK failed/);
    expect(rollbacks).toHaveLength(1); // the catch does not roll back a second time
  });
});

