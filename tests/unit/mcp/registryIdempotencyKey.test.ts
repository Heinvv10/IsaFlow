/**
 * What the idempotency key does and does NOT survive.
 *
 * The key exists so one logical operation writes once. `registry.call()` stores
 * a result under it only when the handler SUCCEEDED AND WROTE; everything else
 * — a refusal, a throw, an insufficient-Flows rejection, a dry run — audits
 * with a NULL key so the key stays usable.
 *
 * That freedom has a sharp edge, and the last two tests here are the proof of
 * it: a handler that WRITES and then returns a toolError is re-run by the
 * agent's retry and writes a SECOND time, because the savepoint only unwinds on
 * a throw. Nothing at this layer can stop that — which is why the tool-side rule
 * (only PRE-write validation may return toolError) is load-bearing rather than
 * stylistic. See writeToolPartialWriteRollback.test.ts for the tools' half.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const savepointMock = vi.hoisted(() => vi.fn(async (_name: string, cb: () => unknown) => cb()));

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withSavepoint: savepointMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { McpRegistry } from '@/lib/mcp/registry';
import { hashArgs } from '@/lib/mcp/audit';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { resetSqlMock, mockSqlOnce, sqlCallText, sqlCallValues, sqlMock } from '../auth/helpers';

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';

function ctxWithScopes(scopes: string[]): McpToolContext {
  return {
    userId: 'user-1',
    companyId: COMPANY_ID,
    scopes,
    tokenJti: 'pat-33333333',
    oauthAppId: null,
  };
}

function makeTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 't',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read:reports',
    write: false,
    handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"ok"' }] })),
    ...overrides,
  };
}

/** SQL text of audit INSERTs issued so far (filters out replay SELECTs). */
function auditInserts(): Array<{ text: string; values: unknown[] }> {
  return sqlMock.mock.calls
    .map((_, i) => ({ text: sqlCallText(i), values: sqlCallValues(i) }))
    .filter((c) => c.text.includes('INSERT INTO mcp_tool_calls'));
}

let registry: McpRegistry;

beforeEach(() => {
  resetSqlMock();
  savepointMock.mockClear();
  registry = new McpRegistry();
});

// A handler REFUSAL (isError) is not a completed operation. Audited under the
// real key it would replay forever: the partial unique index is
// (company_id, tool, idempotency_key) with no status column and recordToolCall
// does ON CONFLICT DO NOTHING, so the row occupies the key permanently.
// Most of these refusals are state-dependent — "Not found" for a row that had
// not committed yet, "Transaction already allocated" — so the identical call
// becomes correct once the state is fixed. Nothing wrote, so nothing is at risk
// from re-running.
describe('McpRegistry — a handler refusal must not burn the idempotency key', () => {
  const refuse = async () => ({
    content: [{ type: 'text' as const, text: 'Not found' }],
    isError: true,
  });

  it('audits a write-tool refusal as rejected with a NULL key', async () => {
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: refuse }));
    const r = await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));

    expect(r.isError).toBe(true);
    const insert = auditInserts().at(-1)!;
    expect(insert.values).toContain('rejected');
    expect(insert.values).not.toContain('k1');
  });

  it('does not store the refusal as a replayable result', async () => {
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: refuse }));
    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));

    const insert = auditInserts().at(-1)!;
    // The stored result column is what findIdempotentReplay serves back.
    expect(insert.values.some((v) => typeof v === 'string' && v.includes('Not found'))).toBe(false);
  });

  it('still audits a SUCCESS under the key, so a genuine replay is served', async () => {
    const ok = async () => ({ content: [{ type: 'text' as const, text: '"done"' }] });
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: ok }));
    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));

    const insert = auditInserts().at(-1)!;
    expect(insert.values).toContain('ok');
    expect(insert.values).toContain('k1');
  });
});

// The dangerous corollary of freeing the key on refusal: a handler that WROTE
// and then returned a toolError gets its key freed too, so the retry re-runs
// and writes a second time. The rule that closes it is a tool-side one — only
// PRE-write validation may return toolError — and this pins the registry half:
// the key really is free, so nothing at this layer stops the second write.
describe('McpRegistry — a freed key means the handler must not have written', () => {
  it('re-runs a write-then-refuse handler on the same key (which is why tools rethrow)', async () => {
    let writes = 0;
    const writeThenRefuse = async () => {
      writes += 1;                                    // stands in for a posted journal
      return { content: [{ type: 'text' as const, text: 'Not found' }], isError: true };
    };
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: writeThenRefuse }));

    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));
    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));

    // Two writes from one key. No MCP tool may be shaped like this handler:
    // rethrow instead, and the savepoint unwinds the first write.
    expect(writes).toBe(2);
  });

  it('serves the stored result on a repeated key once the handler SUCCEEDS, so one write stays one', async () => {
    let writes = 0;
    const write = async () => {
      writes += 1;
      return { content: [{ type: 'text' as const, text: '"posted"' }] };
    };
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: write }));

    const args = { idempotency_key: 'k1' };
    const first = await registry.call('w', args, ctxWithScopes([]));

    // Second call: advisory lock, then the replay SELECT finds the stored 'ok'
    // row written by the first — same call order as the replay test below.
    mockSqlOnce([]);                                                    // advisory lock
    mockSqlOnce([{ result: first, args_hash: hashArgs(args) }]);        // replay SELECT
    await registry.call('w', args, ctxWithScopes([]));

    expect(writes).toBe(1);
  });
});

// A dry run writes nothing, so it must not occupy the key: the real call that
// follows carries the same intent and would be served the preview forever.
describe('McpRegistry — a dry run does not occupy the idempotency key', () => {
  it('audits a wroteNothing success with a NULL key and stores no result', async () => {
    const dryRun = async () => ({
      content: [{ type: 'text' as const, text: '{"posted":0}' }],
      wroteNothing: true,
    });
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: dryRun }));

    const r = await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));

    expect(r.isError).toBeUndefined();
    const insert = auditInserts().at(-1)!;
    expect(insert.values).toContain('ok');            // it SUCCEEDED, unlike a refusal
    expect(insert.values).not.toContain('k1');        // but the key stays free
  });

  it('never puts the internal flag on the wire', async () => {
    const dryRun = async () => ({
      content: [{ type: 'text' as const, text: '{"posted":0}' }],
      wroteNothing: true,
    });
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: dryRun }));

    const r = await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));
    expect('wroteNothing' in r).toBe(false);
  });
});
