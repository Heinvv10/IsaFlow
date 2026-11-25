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
vi.mock('@/lib/rollbackFailed', () => ({ rollbackFailed: async (c: { query: (t: string) => Promise<unknown> }) => { await c.query('ROLLBACK'); return false; } }));

import { EventEmitter } from 'node:events';
import { CommitUnconfirmedError, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

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
