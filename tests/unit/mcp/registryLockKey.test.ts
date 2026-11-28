/**
 * Round 25 (R25-8): the key the registry hands to acquireIdempotencyLock is the supplied key TRIMMED and, for a per-user tool, namespaced by
 * the caller ("u:<user>:<key>"). The Sage migration takes that same lock without waiting first (sageKeyLock.idempotencyLockText), so both
 * rules are pinned here on the registry's side, and in sageKeyLock.test.ts on the migration's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const locks = vi.hoisted(() => ({ calls: [] as Array<[string, string, string]> }));
vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(async () => []), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/mcp/audit', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/audit')>()),
  acquireIdempotencyLock: vi.fn(async (companyId: string, tool: string, key: string) => { locks.calls.push([companyId, tool, key]); }),
  findIdempotentReplay: vi.fn(async () => ({ status: 'none' })),
  recordToolCall: vi.fn(async () => undefined),
}));

import { McpRegistry } from '@/lib/mcp/registry';
import { idempotencyLockText } from '@/modules/accounting/services/sage-migration/sageKeyLock';

const C = '22222222-2222-2222-2222-222222222222';
const ctx = { userId: 'user-1', companyId: C, companyRole: 'owner' as const, scopes: [], tokenJti: 'pat-1', oauthAppId: null };
let registry: McpRegistry;
beforeEach(() => {
  locks.calls.length = 0;
  registry = new McpRegistry();
  const handler = async () => ({ content: [{ type: 'text' as const, text: '"ok"' }] });
  const schema = { type: 'object' as const, properties: {}, additionalProperties: true };
  registry.register({ name: 'w', description: 'write', inputSchema: schema, scope: null, write: true, handler });
  registry.register({ name: 'pu', description: 'per-user write', inputSchema: schema, scope: null, write: true, perUserIdempotency: true, handler });
});

describe('the registry\'s idempotency lock key', () => {
  it('is the key trimmed; a per-user tool\'s is "u:<user>:<key>" — what the migration\'s idempotencyLockText builds', async () => {
    await registry.call('w', { idempotency_key: '  k1  ' }, ctx);
    await registry.call('pu', { idempotency_key: ' k2' }, ctx);
    expect(locks.calls).toEqual([[C, 'w', 'k1'], [C, 'pu', 'u:user-1:k2']]);
    // audit.ts locks `mcp:${companyId}:${tool}:${key}` (pinned in sageKeyLockText.test.ts): the same texts as the migration's
    expect(locks.calls.map(([c, t, k]) => `mcp:${c}:${t}:${k}`)).toEqual([idempotencyLockText(C, 'w', '  k1  '), idempotencyLockText(C, 'pu', ' k2', 'user-1')]);
  });
});
