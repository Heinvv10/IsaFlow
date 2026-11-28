/**
 * ctx.onIdempotentReplay (round-12 structural rule of the Sage migration): the registry tells an in-process caller when it served a STORED
 * answer instead of running the tool, so "replayed, nothing written" is never inferred from rows that are absent afterwards. A fresh call
 * does not fire it, and nothing about it reaches the wire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const savepointMock = vi.hoisted(() => vi.fn(async (_name: string, cb: () => unknown) => cb()));
vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: savepointMock, withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { McpRegistry } from '@/lib/mcp/registry';
import { hashArgs } from '@/lib/mcp/audit';
import type { McpToolContext } from '@/lib/mcp/types';
import { mockSqlOnce, resetSqlMock } from '../auth/helpers';

const ctx = (onIdempotentReplay?: () => void): McpToolContext => ({
  userId: 'user-1', companyId: '22222222-2222-2222-2222-222222222222', companyRole: 'owner', scopes: [], tokenJti: 'pat-1', oauthAppId: null,
  ...(onIdempotentReplay ? { onIdempotentReplay } : {}),
});

let registry: McpRegistry;
let writes = 0;
beforeEach(() => {
  resetSqlMock();
  writes = 0;
  registry = new McpRegistry();
  registry.register({
    name: 'w', description: 'write', inputSchema: { type: 'object', properties: {}, additionalProperties: true }, scope: null, write: true,
    handler: async () => { writes += 1; return { content: [{ type: 'text' as const, text: '"posted"' }] }; },
  });
});

describe('McpRegistry — onIdempotentReplay', () => {
  it('fires when a stored answer is served (the handler does not run), and not on a fresh call', async () => {
    const replays = vi.fn();
    const args = { idempotency_key: 'k1' };
    const first = await registry.call('w', args, ctx(replays));
    expect([writes, replays.mock.calls.length]).toEqual([1, 0]);
    mockSqlOnce([]);                                                  // advisory lock
    mockSqlOnce([{ result: first, args_hash: hashArgs(args) }]);      // replay SELECT finds the stored 'ok'
    const second = await registry.call('w', args, ctx(replays));
    expect([writes, replays.mock.calls.length]).toEqual([1, 1]);
    expect(second).toEqual(first); // nothing about the hook on the wire
  });
  it('a caller without the hook is served the replay as before', async () => {
    const args = { idempotency_key: 'k2' };
    const first = await registry.call('w', args, ctx());
    mockSqlOnce([]);
    mockSqlOnce([{ result: first, args_hash: hashArgs(args) }]);
    expect(await registry.call('w', args, ctx())).toEqual(first);
    expect(writes).toBe(1);
  });
});
