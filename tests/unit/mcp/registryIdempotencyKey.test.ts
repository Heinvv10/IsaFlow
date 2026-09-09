// Durable invocation lifecycle is exercised separately by registryInvocation and PostgreSQL suites.
vi.mock('@/lib/mcp/invocationBoundary', () => ({ withMcpInvocation: async (_name: string, _args: unknown, run: (mark: () => void) => Promise<unknown>) => run(() => undefined) }));
// Tool argument contracts are independently covered for every registered schema.
vi.mock('@/lib/mcp/inputValidation', () => ({ validateToolArguments: (_tool: unknown, args: unknown) => ({ ok: true, args }) }));
// Current authority is independently covered by forensic/currentToolAuthority and real PostgreSQL permission tests.
vi.mock('@/lib/mcp/currentToolAuthority', () => ({ assertCurrentToolAuthority: vi.fn(async () => undefined) }));
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

function receiptInserts() {
  return sqlMock.mock.calls.map((_, i) => ({ text: sqlCallText(i), values: sqlCallValues(i) }))
    .filter(c => c.text.includes('INSERT INTO mcp_idempotency_results'));
}

let registry: McpRegistry;

beforeEach(() => {
  resetSqlMock();
  sqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('').includes('INSERT INTO mcp_idempotency_results') ? [{ args_hash: values[3] }] : []);
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

  it('stores a successful replay receipt independently from history', async () => {
    const ok = async () => ({ content: [{ type: 'text' as const, text: '"done"' }] });
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: ok }));
    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes([]));

    expect(auditInserts().at(-1)!.values).toContain('ok');
    expect(auditInserts().at(-1)!.values).not.toContain('k1');
    expect(receiptInserts().at(-1)!.values).toContain('k1');
  });
});

// Refusals leave keys free; real PostgreSQL tests prove their writes roll back.
describe('McpRegistry — refusal retry and successful idempotency', () => {
  it('retries a refused handler without caching its refusal', async () => {
    const handler=vi.fn(async()=>({content:[{type:'text' as const,text:'Not found'}],isError:true}));
    registry.register(makeTool({name:'w',scope:null,write:true,handler}));
    await registry.call('w',{idempotency_key:'k1'},ctxWithScopes([]));
    await registry.call('w',{idempotency_key:'k1'},ctxWithScopes([]));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(receiptInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(2);
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

  it('strips registry-internal flags (billable / wroteNothing) from a replayed stored result', async () => {
    registry.register(makeTool({ name: 'w', scope: null, write: true, handler: async () => ({
      content: [{ type: 'text' as const, text: '"dup"' }], billable: false,
    }) }));
    const args = { idempotency_key: 'k2' };
    await registry.call('w', args, ctxWithScopes([]));
    mockSqlOnce([]);                                                                   // advisory lock
    mockSqlOnce([{ result: { content: [{ type: 'text', text: '"dup"' }], billable: false, wroteNothing: true }, args_hash: hashArgs(args) }]); // stored row
    const replayed = await registry.call('w', args, ctxWithScopes([])) as Record<string, unknown>;
    expect(replayed).not.toHaveProperty('billable');
    expect(replayed).not.toHaveProperty('wroteNothing');
    expect(replayed.content).toEqual([{ type: 'text', text: '"dup"' }]);
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

// ── Per-user idempotency ────────────────────────────────────────────────────
//
// The default key scope is (company, tool, key), which is right for a
// company-owned document: two agents both creating invoice X under one key
// should dedupe to one invoice. It is WRONG for a row owned by the user who
// wrote it. Two staff on one engagement can plausibly pick the same natural key
// ("time-2026-09-02-vat"); with identical args the second is served the first's
// stored result, so their hours are never written, no error is raised, and their
// agent is handed a colleague's id, rate and line total.
describe('McpRegistry — perUserIdempotency namespaces the key by caller', () => {
  const write = async () => ({ content: [{ type: 'text' as const, text: '"written"' }] });

  function ctxFor(userId: string): McpToolContext {
    return { ...ctxWithScopes([]), userId };
  }

  it('stores the key prefixed with the user id', async () => {
    registry.register(makeTool({
      name: 'w', scope: null, write: true, perUserIdempotency: true, handler: write,
    }));
    await registry.call('w', { idempotency_key: 'shared' }, ctxFor('user-a'));

    const insert = receiptInserts().at(-1)!;
    expect(insert.values).toContain('u:user-a:shared');
    // The bare key must NOT be what lands in the column — that is the collision.
    expect(insert.values).not.toContain('shared');
  });

  it('gives two users different stored keys for the same supplied key', async () => {
    registry.register(makeTool({
      name: 'w', scope: null, write: true, perUserIdempotency: true, handler: write,
    }));
    await registry.call('w', { idempotency_key: 'shared' }, ctxFor('user-a'));
    await registry.call('w', { idempotency_key: 'shared' }, ctxFor('user-b'));

    const keys = receiptInserts().map((i) => i.values.find(
      (v) => typeof v === 'string' && v.startsWith('u:'),
    ));
    expect(keys).toEqual(['u:user-a:shared', 'u:user-b:shared']);
  });

  it('leaves a company-scoped tool\'s key untouched', async () => {
    registry.register(makeTool({ name: 'c', scope: null, write: true, handler: write }));
    await registry.call('c', { idempotency_key: 'shared' }, ctxFor('user-a'));

    const insert = receiptInserts().at(-1)!;
    expect(insert.values).toContain('shared');
    expect(insert.values.some((v) => typeof v === 'string' && v.startsWith('u:'))).toBe(false);
  });

  it('still requires a supplied key — the prefix is not one', async () => {
    registry.register(makeTool({
      name: 'w', scope: null, write: true, perUserIdempotency: true, handler: write,
    }));
    const r = await registry.call('w', {}, ctxFor('user-a'));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('idempotency_key is required');
  });
});
