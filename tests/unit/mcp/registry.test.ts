/**
 * McpRegistry security proofs — MCP Phase 2, Task 2.2.
 * (Plan located this at src/lib/mcp/__tests__/; vitest only includes
 * tests/unit/**, so it lives here.)
 *
 * The fence is IN the registry, provably BEFORE the handler:
 *  - unknown tool / missing scope / missing write:post / missing
 *    idempotency_key → rejected, handler NEVER invoked, audited 'rejected'
 *  - replay with a stored key returns the stored result without re-running
 *  - handler errors are audited 'error' and surfaced as a GENERIC message
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const savepointMock = vi.hoisted(() => vi.fn(async (_name: string, cb: () => unknown) => cb()));

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    // Real withSavepoint runs cb in a SAVEPOINT and rolls back + re-throws on
    // error; the mock just runs cb (propagating throws), and records the call.
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

describe('McpRegistry — fence order', () => {
  it('unknown tool → isError result (not a throw), audited as rejected', async () => {
    const r = await registry.call('ghost', {}, ctxWithScopes(['read:reports']));
    expect(r.isError).toBe(true);
    const inserts = auditInserts();
    expect(inserts.length).toBe(1);
    expect(inserts[0]!.values).toContain('rejected');
    expect(inserts[0]!.values).toContain('ghost');
  });

  it('missing scope → rejected BEFORE handler runs', async () => {
    const handler = vi.fn();
    registry.register(makeTool({ scope: 'read:reports', handler }));
    const r = await registry.call('t', {}, ctxWithScopes(['read:invoices']));
    expect(r.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(auditInserts()[0]!.values).toContain('rejected');
  });

  it('null scope → any authenticated token may call', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"co"' }] }));
    registry.register(makeTool({ name: 'company_profile', scope: null, handler }));
    const r = await registry.call('company_profile', {}, ctxWithScopes([]));
    expect(r.isError).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('write tool without idempotency_key → rejected before handler', async () => {
    const handler = vi.fn();
    registry.register(makeTool({ write: true, scope: 'write:invoices', handler }));
    const r = await registry.call('t', {}, ctxWithScopes(['write:invoices']));
    expect(r.isError).toBe(true);
    expect(String(r.content[0]!.text)).toContain('idempotency_key');
    expect(handler).not.toHaveBeenCalled();
  });

  it('requiresPost without write:post → rejected pre-handler; error names no other scopes', async () => {
    const handler = vi.fn();
    registry.register(makeTool({
      name: 'post_journal', write: true, scope: 'write:journals', requiresPost: true, handler,
    }));
    const r = await registry.call(
      'post_journal',
      { idempotency_key: 'k1' },
      ctxWithScopes(['write:journals', 'read:reports', 'read:invoices']),
    );
    expect(r.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    const text = r.content[0]!.text;
    expect(text).toContain('write:post');
    for (const other of ['write:journals', 'read:reports', 'read:invoices', 'write:invoices']) {
      expect(text).not.toContain(other);
    }
  });

  it('acquires an advisory lock BEFORE the replay-check for write tools (serialises concurrent same-key calls)', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"ok"' }] }));
    registry.register(makeTool({ name: 'w', write: true, scope: 'write:invoices', handler }));
    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes(['write:invoices']));
    // first sql call is the advisory lock, before the replay SELECT
    expect(sqlCallText(0)).toContain('pg_advisory_xact_lock');
    expect(sqlCallText(0)).toContain('hashtext');
    // the replay SELECT comes AFTER the lock
    const replayIdx = sqlMock.mock.calls.findIndex((_, i) => sqlCallText(i).includes('idempotency_key ='));
    expect(replayIdx).toBeGreaterThan(0);
  });

  it('does NOT lock read tools (no idempotency, no write)', async () => {
    registry.register(makeTool({ handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"ok"' }] })) }));
    await registry.call('t', {}, ctxWithScopes(['read:reports']));
    const lockCalls = sqlMock.mock.calls.filter((_, i) => sqlCallText(i).includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(0);
  });

  it('write replay with same idempotency_key AND same args → stored result, handler NOT called again', async () => {
    const stored = { content: [{ type: 'text' as const, text: '"already-done"' }] };
    const handler = vi.fn();
    registry.register(makeTool({ write: true, scope: 'write:invoices', handler }));
    const args = { idempotency_key: 'k1' };
    mockSqlOnce([]); // advisory lock (call 0)
    mockSqlOnce([{ result: stored, args_hash: hashArgs(args) }]); // replay SELECT (call 1), args agree
    const r = await registry.call('t', args, ctxWithScopes(['write:invoices']));
    expect(r).toEqual(stored);
    expect(handler).not.toHaveBeenCalled();
    const replayIdx = sqlMock.mock.calls.findIndex((_, i) => sqlCallText(i).includes('idempotency_key ='));
    expect(replayIdx).toBeGreaterThanOrEqual(1);
    expect(sqlCallValues(replayIdx)).toEqual(expect.arrayContaining([COMPANY_ID, 't', 'k1']));
  });

  it('same idempotency_key with DIFFERENT args → rejected, handler NOT called, no stale result', async () => {
    const stored = { content: [{ type: 'text' as const, text: '"first-call"' }] };
    const handler = vi.fn();
    registry.register(makeTool({ write: true, scope: 'write:invoices', handler }));
    // stored row was for a different args payload → args_hash won't match
    mockSqlOnce([]); // advisory lock (call 0)
    mockSqlOnce([{ result: stored, args_hash: 'HASH-OF-THE-ORIGINAL-DIFFERENT-ARGS' }]); // replay (call 1)
    const r = await registry.call(
      't', { idempotency_key: 'k1', amount: 999 }, ctxWithScopes(['write:invoices']),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('already used');
    expect(handler).not.toHaveBeenCalled();
    // did NOT return the stored result
    expect(r.content[0]!.text).not.toContain('first-call');
  });

  it('data minimisation: read-tool audit stores NULL result; write-tool stores it', async () => {
    // read tool (write:false) → result column is JSON null
    registry.register(makeTool({
      name: 'r', scope: 'read:reports',
      handler: async () => ({ content: [{ type: 'text' as const, text: '"secret financials"' }] }),
    }));
    await registry.call('r', {}, ctxWithScopes(['read:reports']));
    const readInsert = auditInserts()[0]!;
    expect(readInsert.values).toContain('null'); // JSON.stringify(null)
    expect(readInsert.values.some((v) => String(v).includes('secret financials'))).toBe(false);

    // write tool (write:true) → result IS stored (needed for replay)
    resetSqlMock();
    registry.register(makeTool({
      name: 'w', scope: 'write:invoices', write: true,
      handler: async () => ({ content: [{ type: 'text' as const, text: '"created inv-1"' }] }),
    }));
    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes(['write:invoices']));
    const writeInsert = auditInserts()[0]!;
    expect(writeInsert.values.some((v) => String(v).includes('created inv-1'))).toBe(true);
  });

  it('happy path → handler called with ctx, audited status ok with tenant + jti', async () => {
    const handler = vi.fn(async (_args: unknown, ctx: McpToolContext) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ co: ctx.companyId }) }],
    }));
    registry.register(makeTool({ handler }));
    const ctx = ctxWithScopes(['read:reports']);
    const r = await registry.call('t', { a: 1 }, ctx);
    expect(r.isError).toBeUndefined();
    expect(handler).toHaveBeenCalledWith({ a: 1 }, ctx);
    const insert = auditInserts()[0]!;
    expect(insert.values).toEqual(
      expect.arrayContaining(['ok', 't', COMPANY_ID, 'user-1', 'pat-33333333', hashArgs({ a: 1 })]),
    );
  });

  it('handler throw → generic isError, audited status error, nothing internal leaked', async () => {
    const handler = vi.fn(async () => {
      throw new Error('duplicate key value violates unique constraint "gl_journal_lines_pkey"');
    });
    registry.register(makeTool({ handler }));
    const r = await registry.call('t', {}, ctxWithScopes(['read:reports']));
    expect(r.isError).toBe(true);
    const text = r.content[0]!.text;
    expect(text).not.toContain('unique constraint');
    expect(text).not.toContain('gl_journal_lines');
    expect(text).not.toContain('Error');
    expect(auditInserts()[0]!.values).toContain('error');
  });

  it('WRITE tool runs inside a savepoint so a mid-write throw rolls back partial writes', async () => {
    const handler = vi.fn(async () => { throw new Error('constraint violation mid-write'); });
    registry.register(makeTool({ name: 'w', write: true, scope: 'write:invoices', handler }));
    const r = await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes(['write:invoices']));
    expect(r.isError).toBe(true);
    // the handler ran inside withSavepoint (which rolls back to the savepoint on throw)
    expect(savepointMock).toHaveBeenCalledWith('mcp_w', expect.any(Function));
    // the error audit runs OUTSIDE the rolled-back savepoint
    expect(auditInserts().some((c) => c.values.includes('error'))).toBe(true);
  });

  it('a failed handler is audited WITHOUT the idempotency key, so a retry is not burned', async () => {
    const handler = vi.fn(async () => { throw new Error('GL post failed'); });
    registry.register(makeTool({ name: 'w', write: true, scope: 'write:invoices', handler }));

    await registry.call('w', { idempotency_key: 'k1' }, ctxWithScopes(['write:invoices']));

    // The partial unique index is (company_id, tool, idempotency_key) and
    // recordToolCall does ON CONFLICT DO NOTHING. An 'error' row carrying the
    // real key permanently occupies that slot: the retry's successful 'ok' row
    // is silently dropped, and since findIdempotentReplay matches only
    // status='ok', every later retry re-runs the handler instead of replaying.
    // Same reasoning as the insufficient-Flows reject path, which already
    // passes null.
    const errorRow = auditInserts().find((c) => c.values.includes('error'));
    expect(errorRow, 'the failure must still be audited').toBeDefined();
    expect(errorRow!.values).not.toContain('k1');
  });

  it('READ tools are NOT savepoint-wrapped (no writes to roll back)', async () => {
    registry.register(makeTool({ handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"ok"' }] })) }));
    await registry.call('t', {}, ctxWithScopes(['read:reports']));
    expect(savepointMock).not.toHaveBeenCalled();
  });

  it('register throws on a duplicate tool name', () => {
    registry.register(makeTool());
    expect(() => registry.register(makeTool())).toThrow(/duplicate/);
  });

  it('getManifest exposes name/description/inputSchema only', () => {
    registry.register(makeTool());
    const manifest = registry.getManifest();
    expect(manifest).toEqual([
      { name: 't', description: 'test tool', inputSchema: expect.any(Object) },
    ]);
    expect(Object.keys(manifest[0]!)).toEqual(['name', 'description', 'inputSchema']);
  });
});

describe('hashArgs', () => {
  it('is key-order insensitive and value sensitive', () => {
    expect(hashArgs({ a: 1, b: { d: 2, c: 3 } })).toBe(hashArgs({ b: { c: 3, d: 2 }, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });
});
