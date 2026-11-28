/**
 * Round 38 (B38-1, R38-2, R38-4): what the session commits and what it says it committed.
 *   - B38-1: a request whose context the registry marked unusable (als.markTxUnusable: a ROLLBACK TO SAVEPOINT failed) is never
 *     committed, like one marked rollback-only: no COMMIT is sent, it is rolled back, and it fails with nothing written.
 *   - B38-1: a COMMIT the server answers with the ROLLBACK command tag (the transaction had been aborted) is a refused COMMIT, nothing
 *     written, never "committed".
 *   - R38-2: a COMMIT answered OK is decided: after-commit hooks that throw cannot turn it into a failure.
 *   - R38-4: a release that throws is followed by a release(true) (the connection destroyed); a logger that throws changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/lib/als';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const h = vi.hoisted(() => ({
  call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>(),
  ctx: null as RequestContext | null,
  drain: vi.fn<() => void>(),
  logError: vi.fn<(...a: unknown[]) => void>(),
}));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }], call: h.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({ getCompanyMembership: async () => ({ rows: [{ account_user_id: 'u1', role: 'owner' }] }) }));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
vi.mock('@/lib/afterCommit', () => ({
  runOwnedContext: (ctx: RequestContext, fn: () => unknown) => { h.ctx = ctx; return fn(); },
  drainAfterCommit: () => h.drain(),
  settleAfterRollback: () => undefined,
}));
vi.mock('@/lib/logger', () => ({ log: { error: (...a: unknown[]) => h.logError(...a), warn: () => undefined, info: () => undefined, debug: () => undefined } }));

import { EventEmitter } from 'node:events';
import { CommitRefusedError, CommitUnconfirmedError, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const clientOf = (commit: () => unknown, release: (destroy?: unknown) => void = () => undefined) => {
  const sent: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: async (text: string) => { sent.push(text); return text === 'COMMIT' ? commit() : { rows: [], command: text }; },
    release: vi.fn(release),
  });
  return { client, sent };
};
const run = (client: unknown) => withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' }));

beforeEach(() => { h.call.mockReset(); h.drain.mockReset(); h.logError.mockReset(); h.ctx = null; });

describe('B38-1: a request the registry marked unusable or rollback-only is never committed', () => {
  for (const field of ['txUnusable', 'rollbackOnly'] as const) {
    it(`${field}: no COMMIT sent, rolled back, failed (not unconfirmed), the connection kept`, async () => {
      h.call.mockImplementationOnce(async () => { h.ctx![field] = 'ROLLBACK TO SAVEPOINT failed'; return ok('{"created":1}'); });
      const { client, sent } = clientOf(() => ({ rows: [], command: 'COMMIT' }));
      const err = await run(client).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CommitUnconfirmedError);
      expect((err as Error).message).toContain('not committed: ROLLBACK TO SAVEPOINT failed');
      expect(sent).not.toContain('COMMIT');
      expect(sent.at(-1)).toBe('ROLLBACK');
      expect(client.release).toHaveBeenCalledWith(false);
    });
  }
});

describe('B38-1: a COMMIT answered with the ROLLBACK command tag', () => {
  it('is a refused COMMIT: nothing written, never committed', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    const { client } = clientOf(() => ({ rows: [], command: 'ROLLBACK' }));
    const err = await run(client).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommitRefusedError);
    expect((err as Error).message).toContain('nothing of it was written');
    expect(h.drain).not.toHaveBeenCalled();
  });
  it('a COMMIT answered COMMIT is committed (the tag read, the result returned)', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    const { client } = clientOf(() => ({ rows: [], command: 'COMMIT' }));
    await expect(run(client)).resolves.toMatchObject({ isError: false, body: { created: 1 } });
    expect(h.drain).toHaveBeenCalledTimes(1);
  });
  it('an answer whose command cannot be read, or has none, is not a refusal (pg always tags a COMMIT): committed as before', async () => {
    const hostile = new Proxy({}, { get: (_t, k) => { if (k === 'command') throw new Error('injected: command getter'); return undefined; } });
    for (const answer of [hostile, { rows: [] }, undefined]) {
      h.call.mockResolvedValueOnce(ok('{"created":1}'));
      const { client } = clientOf(() => answer);
      await expect(run(client)).resolves.toMatchObject({ isError: false });
    }
  });
});

describe('R38-2: an OK COMMIT is decided', () => {
  it('after-commit hooks that throw are logged; the call still answers what it committed', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    h.drain.mockImplementationOnce(() => { throw new Error('injected: hook'); });
    const { client } = clientOf(() => ({ rows: [], command: 'COMMIT' }));
    await expect(run(client)).resolves.toMatchObject({ isError: false, body: { created: 1 } });
    expect(h.logError.mock.calls.some(([m]) => String(m).includes('after-commit hooks failed'))).toBe(true);
    expect(client.release).toHaveBeenCalledWith(false);
  });
});

describe('R38-4: the cleanup after the request cannot throw', () => {
  it('a release that throws: the connection is released again with true (destroyed); the outcome stands', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    let n = 0;
    const { client } = clientOf(() => ({ rows: [], command: 'COMMIT' }), () => { if (n++ === 0) throw new Error('injected: release'); });
    await expect(run(client)).resolves.toMatchObject({ isError: false });
    expect(client.release.mock.calls).toEqual([[false], [true]]);
  });
  it('a release that throws twice and a logger that throws: still the outcome', async () => {
    h.call.mockResolvedValueOnce(ok('{"created":1}'));
    h.logError.mockImplementation(() => { throw new Error('injected: logger'); });
    const { client } = clientOf(() => { throw new Error('COMMIT did not answer'); }, () => { throw new Error('injected: release'); });
    const err = await run(client).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommitUnconfirmedError);
    expect(client.release).toHaveBeenCalledTimes(2);
  });
});
