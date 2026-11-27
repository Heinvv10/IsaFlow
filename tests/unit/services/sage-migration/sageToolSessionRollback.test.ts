/**
 * Round 37 (B37-1, R37-1, R37-2, B37-2): with the REAL rollbackError (src/lib/rollbackFailed.ts), a COMMIT that fails with a plain Error
 * or any hostile value (hostileValues.ts), whether or not it was sent, then a ROLLBACK that answers, fails, or fails with a hostile value:
 * the outcome is always CommitUnconfirmedError (decided from the session's state, first), and a ROLLBACK that did not answer OK always
 * destroys the connection (release(true)), so no open transaction goes back to the pool. Also: a hostile client 'error', a value that
 * reads differently each time (a Proxy whose getPrototypeOf answers once, then throws), a release that throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { hostileValues } from './hostileValues';

const registry = vi.hoisted(() => ({ call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>() }));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }], call: registry.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({ getCompanyMembership: async () => ({ rows: [{ account_user_id: 'u1', role: 'owner' }] }) }));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (_ctx: unknown, fn: () => unknown) => fn(), drainAfterCommit: () => undefined, settleAfterRollback: () => undefined }));

import { EventEmitter } from 'node:events';
import { CommitUnconfirmedError, ConnectionLostError, DryRollbackUnconfirmedError, LostBeforeCommitError, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';
import { rollbackError } from '@/lib/rollbackFailed';

const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
/** A Proxy over an Error whose getPrototypeOf answers `n` times, then throws (B37-2: a value that reads differently the next time). */
const flip = (n: number) => { let k = 0; return new Proxy(new Error('flip'), { getPrototypeOf: (t) => { if (k++ >= n) throw new Error(`flip #${k}`); return Object.getPrototypeOf(t); } }); };
type Answer = ['ok' | 'reject', () => unknown];
const commits: Array<[string, () => unknown]> = [['a plain Error', () => new Error('injected: plain')], ...hostileValues, ['a flip after 1', () => flip(1)], ['a flip after 3', () => flip(3)]];
const rollbacks: Array<[string, Answer]> = [['answers', ['ok', () => undefined]], ['a plain Error', ['reject', () => new Error('ROLLBACK refused')]], ...hostileValues.map(([w, m]): [string, Answer] => [w, ['reject', m]])];

beforeEach(() => { registry.call.mockReset(); });

describe('B37-1: the COMMIT and its ROLLBACK, every combination, with the real rollbackError', () => {
  for (const [cWhat, cMake] of commits) {
    for (const [rWhat, [rKind, rMake]] of rollbacks) {
      it(`COMMIT ${cWhat}, ROLLBACK ${rWhat}: CommitUnconfirmedError; the connection destroyed unless the ROLLBACK answered`, async () => {
        registry.call.mockResolvedValueOnce(ok('{"created":1}'));
        const client = Object.assign(new EventEmitter(), {
          query: async (text: string) => {
            if (text === 'COMMIT') throw cMake();
            if (text === 'ROLLBACK' && rKind === 'reject') throw rMake();
            return { rows: [] };
          },
          release: vi.fn(),
        });
        const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(CommitUnconfirmedError);
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(client.release).toHaveBeenCalledWith(rKind === 'reject');
      });
    }
  }
});

describe('R37-1: rollbackError never throws, whatever the ROLLBACK rejects with', () => {
  for (const [what, make] of hostileValues) {
    it(`${what}: an Error whose message reads, never a throw`, async () => {
      const e = await rollbackError({ query: async () => { throw make(); } }, 'test');
      expect(e).toBeInstanceOf(Error);
      expect(typeof (e as Error).message).toBe('string');
    });
  }
  it('a readable Error is handed on as it is (its code and class kept for the other callers)', async () => {
    const real = Object.assign(new Error('terminating connection'), { code: '57P01' });
    expect(await rollbackError({ query: async () => { throw real; } }, 'test')).toBe(real);
  });
});

describe('R37-2 / part 2: what enters the session is snapshotted', () => {
  for (const [what, make] of hostileValues) {
    it(`a client 'error' of ${what}: the loss stands, said as lost before the COMMIT; no throw`, async () => {
      const client = Object.assign(new EventEmitter(), { query: async () => ({ rows: [] }), release: vi.fn() });
      registry.call.mockImplementationOnce(async () => { client.emit('error', make()); return ok('{"created":1}'); });
      const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(LostBeforeCommitError);
      expect(() => String((err as Error).message)).not.toThrow();
      expect(Object.isFrozen((err as { cause?: unknown }).cause)).toBe(true); // the loss is our snapshot, never the event's value
      expect(client.release).toHaveBeenCalledWith(true);
    });
  }
  it('a query that rejects with a real "Query read timeout": the loss kept is our snapshot of it, not the driver\'s Error', async () => {
    const real = new Error('Query read timeout');
    const client = Object.assign(new EventEmitter(), { query: async (text: string) => { if (text === 'SET LOCAL ROLE app_user') throw real; return { rows: [] }; }, release: vi.fn() });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LostBeforeCommitError);
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).not.toBe(real);
    expect(Object.isFrozen(cause)).toBe(true);
    expect((cause as Error).message).toBe('Query read timeout');
  });
  it('a release that throws cannot replace the outcome', async () => {
    registry.call.mockResolvedValueOnce(ok('{"created":1}'));
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string) => { if (text === 'COMMIT') throw new Error('COMMIT did not answer'); return { rows: [] }; },
      release: vi.fn(() => { throw new Error('release blew up'); }),
    });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommitUnconfirmedError);
  });
});

describe('part 2 at every entry: what reaches the caller is ours, frozen, never the value that entered', () => {
  const revoked = () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; };
  const UNREADABLE = 'an error whose message cannot be read';
  it('a pool.connect that rejects: the loss carries our snapshot', async () => {
    const real = new Error('connect ECONNREFUSED');
    const err = await withToolSession({ connect: async () => { throw real; } } as never, 'c1', 'u1', true, async () => undefined).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LostBeforeCommitError);
    expect(Object.isFrozen((err as { cause?: unknown }).cause)).toBe(true);
    const dry = await withToolSession({ connect: async () => { throw real; } } as never, 'c1', 'u1', false, async () => undefined).then(() => null, (e: unknown) => e);
    expect(dry).toBeInstanceOf(ConnectionLostError);
    expect((dry as { cause?: unknown }).cause).not.toBe(real);
  });
  it('the dry run\'s ROLLBACK that fails: DryRollbackUnconfirmedError carries our snapshot of its failure', async () => {
    const client = Object.assign(new EventEmitter(), { query: async (text: string) => { if (text === 'ROLLBACK') throw new Error('ROLLBACK refused'); return { rows: [] }; }, release: vi.fn() });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => 'read', { wrote: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DryRollbackUnconfirmedError);
    expect(Object.isFrozen((err as { cause?: unknown }).cause)).toBe(true);
  });
  it('a registry call that rejects with a revoked Proxy: the request fails with our wording, never a TypeError from reading it', async () => {
    registry.call.mockImplementationOnce(async () => { throw revoked(); });
    const client = Object.assign(new EventEmitter(), { query: async () => ({ rows: [] }), release: vi.fn() });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(UNREADABLE);
    expect(Object.isFrozen(err)).toBe(true);
  });
  it('a request whose own work throws a revoked Proxy: the same', async () => {
    const client = Object.assign(new EventEmitter(), { query: async () => ({ rows: [] }), release: vi.fn() });
    const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', false, async () => { throw revoked(); }).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(UNREADABLE);
    expect(Object.isFrozen(err)).toBe(true);
  });
});

