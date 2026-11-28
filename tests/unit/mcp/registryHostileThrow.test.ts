/**
 * Round 38, breaker (c): a tool now gets the driver's own rejection (sage migration, round 37), so whatever a handler throws reaches the
 * registry's catch. A value whose message, string form or prototype cannot be read (hostileValues.ts, and a Proxy whose getPrototypeOf
 * throws, which the error-text classifier's instanceof reads) is answered like any thrown failure: the generic text, the call refunded,
 * audited 'error' with no key. The registry never throws a second error of its own out of the catch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/mcp/audit', () => ({ hashArgs: vi.fn(() => 'hash-1'), recordToolCall: vi.fn(), acquireIdempotencyLock: vi.fn(), findIdempotentReplay: vi.fn(async () => ({ status: 'none' })) }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(), refundForTool: vi.fn() }));

import { McpRegistry } from '@/lib/mcp/registry';
import { recordToolCall } from '@/lib/mcp/audit';
import { debitForTool, refundForTool } from '@/lib/mcp/flowMetering';
import { GENERIC_FAILURE } from '@/lib/mcp/thrownToolErrorText';
import { log } from '@/lib/logger';
import type { McpToolContext } from '@/lib/mcp/types';
import { hostileValues } from '../services/sage-migration/hostileValues';

const ctx: McpToolContext = { userId: 'user-1', companyId: '22222222-2222-2222-2222-222222222222', companyRole: 'owner', scopes: ['read:reports'], tokenJti: 'pat-1', oauthAppId: null };
const HANDLE = { code: 'report.tb' as const, cost: 10 };
const values: Array<[string, () => unknown]> = [
  ...hostileValues,
  ['a Proxy whose getPrototypeOf throws', () => new Proxy(new Error('p'), { getPrototypeOf: () => { throw new Error('injected: getPrototypeOf'); } })],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(debitForTool).mockResolvedValue({ ok: true, handle: HANDLE } as never);
});

describe('B38 (c): the registry\'s catch reads a thrown value without a throw', () => {
  for (const [what, make] of values) {
    it(`${what}: the generic failure, refunded, audited 'error' with no key`, async () => {
      const r = new McpRegistry();
      r.register({ name: 'trial_balance', description: 'd', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, scope: 'read:reports', write: false,
        handler: async () => { throw make(); } });
      const res = await r.call('trial_balance', {}, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toBe(GENERIC_FAILURE);
      expect(refundForTool).toHaveBeenCalledWith(ctx.companyId, HANDLE);
      expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', idempotencyKey: null }));
      const [, meta] = vi.mocked(log.error).mock.calls.find(([m]) => m === 'MCP tool handler failed')!;
      expect(typeof (meta as { err: unknown }).err).toBe('string');
    });
  }
});
