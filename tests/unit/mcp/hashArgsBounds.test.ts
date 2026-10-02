/**
 * hashArgs runs BEFORE the registry's NUL/shape guard, so it must be as bounded as `hasNul`:
 * a deeply nested, cyclic or enormous argument object may not blow the stack or run long on
 * every MCP call. Ordinary shapes keep their byte-for-byte hash (the idempotency conflict
 * check compares stored hashes across deploys).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(), refundForTool: vi.fn() }));

import { McpRegistry } from '@/lib/mcp/registry';
import { hashArgs } from '@/lib/mcp/audit';
import { debitForTool } from '@/lib/mcp/flowMetering';
import { hasNul } from '@/lib/validation';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { resetSqlMock, sqlCallText, sqlCallValues, sqlMock } from '../auth/helpers';
import { CORPUS } from './hashArgsCorpus';

const GOLDEN = [
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  '173a203f03a5ca6732ebb75855f5e7121a4544fcdb0a5e00d625efeaea787207',
  'a1e3bf8ecf1155322e07cae568c1a645e72b71e07783383d4fad11d16afe4772',
  '6afcb159ca6b2a94a6e2969e63414c0cf321fd89026753bfb18aec1b60c6feda',
  'afc400877918f12af65641f77687ae742868aaba9a9f870d84287f02216b2360',
  'b9df93e1eb7ee907ea2ccb2236d317bfabdac91df4a80801baa7eff43b2ddcd8',
  'f124362a36461460354796dcb1cb9c1d6c1cd62b3fef291d30b0c452c6c041e2',
  'dfea97868acd0e837de14a40344a7200dc4b3cd2bd1be7eb58d9e3cbf1f466ea',
  '97bbce7d1851e0b39da84dd3dcffd790374fd8210b6c812482eeab7c321e3e4d',
  '3da509eb165e522b11ee9d5ed295acac858d84e4993a8f6ecfc4d2170fdad942',
];

function nested(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < depth; i++) { const next: Record<string, unknown> = {}; cur.n = next; cur = next; }
  return root;
}

function nestedArray(depth: number): Record<string, unknown> {
  let v: unknown = 'leaf';
  for (let i = 0; i < depth; i++) v = [v];
  return { a: v };
}

function cyclic(): Record<string, unknown> {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  o.list = [o, o];
  return o;
}

const ctx: McpToolContext = { userId: 'u', companyId: '22222222-2222-2222-2222-222222222222', scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null };
const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"ok"' }] }));
const tool: McpTool = { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} }, scope: 'read:reports', write: false, handler };

describe('hashArgs bound', () => {
  it('ordinary argument shapes hash byte-for-byte as before the bound existed', () => {
    expect(CORPUS.map((c) => hashArgs(c.args))).toEqual(GOLDEN);
  });

  it('is key-order independent and distinguishes different args', () => {
    expect(hashArgs({ a: { x: 1, y: 2 } })).toBe(hashArgs({ a: { y: 2, x: 1 } }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });

  it.each([
    ['deep object (100k levels)', () => nested(100_000)],
    ['deep array (100k levels)', () => nestedArray(100_000)],
    ['cycle', cyclic],
    ['huge array', () => ({ a: new Array(300_000).fill(1) })],
    ['wide fan-out cycle', () => { const o: Record<string, unknown> = {}; for (let i = 0; i < 50; i++) o[`k${i}`] = o; return o; }],
  ])('%s: returns quickly without throwing', (_n, build) => {
    const started = Date.now();
    expect(() => hashArgs(build())).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('an over-bound shape gets a marker hash that no in-bound args share, and hasNul refuses the same shape', () => {
    const a = hashArgs(nested(50));
    expect(a).not.toBe(hashArgs({}));
    expect(hasNul(nested(50))).toBe(true);
  });
});

describe('registry refuses over-bound arguments', () => {
  let registry: McpRegistry;
  beforeEach(() => {
    resetSqlMock();
    handler.mockClear();
    vi.mocked(debitForTool).mockClear();
    registry = new McpRegistry();
    registry.register(tool);
  });

  it.each([
    ['deep object', () => nested(100_000)],
    ['cycle', cyclic],
    ['huge array', () => ({ a: new Array(300_000).fill(1) })],
  ])('%s: normal validation error, handler never ran, audited rejected, not metered', async (_n, build) => {
    const r = await registry.call('t', build(), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('invalid arguments');
    expect(handler).not.toHaveBeenCalled();
    expect(debitForTool).not.toHaveBeenCalled();
    const inserts = sqlMock.mock.calls
      .map((_, i) => ({ text: sqlCallText(i), values: sqlCallValues(i) }))
      .filter((c) => c.text.includes('INSERT INTO mcp_tool_calls'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toContain('rejected');
  });
});
