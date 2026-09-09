// Durable invocation lifecycle is exercised separately by registryInvocation and PostgreSQL suites.
vi.mock('@/lib/mcp/invocationBoundary', () => ({ withMcpInvocation: async (_name: string, _args: unknown, run: (mark: () => void) => Promise<unknown>) => run(() => undefined) }));
// Tool argument contracts are independently covered for every registered schema.
vi.mock('@/lib/mcp/inputValidation', () => ({ validateToolArguments: (_tool: unknown, args: unknown) => ({ ok: true, args }) }));
// Current authority is independently covered by forensic/currentToolAuthority and real PostgreSQL permission tests.
vi.mock('@/lib/mcp/currentToolAuthority', () => ({ assertCurrentToolAuthority: vi.fn(async () => undefined) }));
// RED phase — written before the registry wiring was trusted.
/**
 * Where the money can go wrong in registry.call().
 *
 * Four failure modes, none of which the flowMetering unit tests can catch
 * because they are all about ORDERING inside the registry:
 *   - charging a replay (billing twice for one operation)
 *   - taking the debit inside the savepoint (rollback + explicit refund =
 *     credited twice)
 *   - not refunding an isError result (charged for nothing)
 *   - running the handler anyway when the wallet is empty
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const savepointMock = vi.hoisted(() => vi.fn(async (_n: string, cb: () => unknown) => cb()));

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
vi.mock('@/lib/mcp/audit', () => ({
  hashArgs: vi.fn(() => 'hash-1'),
  recordToolCall: vi.fn(),
  acquireIdempotencyLock: vi.fn(),
  findIdempotentReplay: vi.fn(async () => ({ status: 'none' })),
}));
vi.mock('@/lib/mcp/flowMetering', () => ({
  debitForTool: vi.fn(),
  refundForTool: vi.fn(),
}));

import { McpRegistry } from '@/lib/mcp/registry';
import { findIdempotentReplay, recordToolCall } from '@/lib/mcp/audit';
import { debitForTool, refundForTool } from '@/lib/mcp/flowMetering';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const ctx: McpToolContext = {
  userId: 'user-1',
  companyId: COMPANY_ID,
  scopes: ['read:reports', 'write:bank-tx'],
  tokenJti: 'pat-1',
  oauthAppId: null,
};

const HANDLE = { code: 'report.tb' as const, cost: 10 };

function makeTool(over: Partial<McpTool> = {}): McpTool {
  return {
    name: 'trial_balance',
    description: 'd',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read:reports',
    write: false,
    handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    ...over,
  };
}

function registryWith(tool: McpTool): McpRegistry {
  const r = new McpRegistry();
  r.register(tool);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  savepointMock.mockImplementation(async (_n: string, cb: () => unknown) => cb());
  vi.mocked(findIdempotentReplay).mockResolvedValue({ status: 'none' } as never);
  vi.mocked(debitForTool).mockResolvedValue({ ok: true, handle: HANDLE } as never);
});

describe('registry metering', () => {
  it('refuses the call when the wallet cannot cover it — the handler never runs', async () => {
    vi.mocked(debitForTool).mockResolvedValue({
      ok: false, code: 'report.tb', balance: 2, required: 10,
    } as never);
    const tool = makeTool();

    const res = await registryWith(tool).call('trial_balance', {}, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/insufficient flows/i);
    expect(tool.handler).not.toHaveBeenCalled();
  });

  it('does not burn the idempotency key when the wallet is short', async () => {
    // The partial unique index is (company_id, tool, idempotency_key) with no
    // status column and recordToolCall does ON CONFLICT DO NOTHING, so a
    // 'rejected' row carrying the key would block the later 'ok' row forever.
    // findIdempotentReplay matches only status='ok', so every retry of that key
    // would then re-run the handler: duplicate documents, duplicate debits.
    vi.mocked(debitForTool).mockResolvedValue({
      ok: false, code: 'journal.create', balance: 0, required: 3,
    } as never);
    const tool = makeTool({ name: 'create_draft_journal', write: true, scope: 'write:bank-tx' });

    await registryWith(tool).call('create_draft_journal', { idempotency_key: 'k1' }, ctx);

    const audited = vi.mocked(recordToolCall).mock.calls[0]![0];
    expect(audited.status).toBe('rejected');
    expect(audited.idempotencyKey).toBeNull();
  });

  it('does not charge an idempotent replay — one operation, one debit', async () => {
    vi.mocked(findIdempotentReplay).mockResolvedValue({
      status: 'match',
      result: { content: [{ type: 'text', text: 'stored' }] },
    } as never);
    const tool = makeTool({ name: 'create_draft_journal', write: true, scope: 'write:bank-tx' });

    const res = await registryWith(tool).call(
      'create_draft_journal', { idempotency_key: 'k1' }, ctx,
    );

    expect(res.content[0]!.text).toBe('stored');
    expect(debitForTool).not.toHaveBeenCalled();
  });

  it('refunds when the handler reports an error instead of doing the work', async () => {
    const tool = makeTool({
      handler: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'bad input' }], isError: true,
      })),
    });

    await registryWith(tool).call('trial_balance', {}, ctx);

    expect(refundForTool).toHaveBeenCalledWith(COMPANY_ID, HANDLE);
  });

  it('refunds when the handler throws', async () => {
    const tool = makeTool({ handler: vi.fn(async () => { throw new Error('boom'); }) });

    const res = await registryWith(tool).call('trial_balance', {}, ctx);

    expect(res.isError).toBe(true);
    expect(refundForTool).toHaveBeenCalledWith(COMPANY_ID, HANDLE);
  });

  it('does not refund a successful call', async () => {
    await registryWith(makeTool()).call('trial_balance', {}, ctx);

    expect(refundForTool).not.toHaveBeenCalled();
  });

  it('refunds a success that did no billable work, and keeps the flag off the wire', async () => {
    // Re-sending a statement whose rows are all already imported succeeds and
    // writes nothing. The tool's own description invites resending, so it must
    // be free — the same rule the dry_run case follows.
    const tool = makeTool({
      handler: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: '{"imported":0}' }],
        billable: false,
      })),
    });

    const res = await registryWith(tool).call('trial_balance', {}, ctx);

    expect(refundForTool).toHaveBeenCalledWith(COMPANY_ID, HANDLE);
    // `billable` is registry-internal and is not part of the MCP wire format.
    expect('billable' in res).toBe(false);
  });

  it('takes the debit OUTSIDE the savepoint — inside it, a rollback plus the explicit refund credits twice', async () => {
    const order: string[] = [];
    vi.mocked(debitForTool).mockImplementation(async () => {
      order.push('debit');
      return { ok: true, handle: HANDLE } as never;
    });
    savepointMock.mockImplementation(async (_n: string, cb: () => unknown) => {
      order.push('savepoint-enter');
      return cb();
    });
    const tool = makeTool({ name: 'create_draft_journal', write: true, scope: 'write:bank-tx' });

    await registryWith(tool).call('create_draft_journal', { idempotency_key: 'k1' }, ctx);

    expect(order).toEqual(['debit', 'savepoint-enter']);
  });

  it('skips the refund entirely for a free tool', async () => {
    vi.mocked(debitForTool).mockResolvedValue({ ok: true, handle: null } as never);
    const tool = makeTool({ handler: vi.fn(async () => { throw new Error('boom'); }) });

    await registryWith(tool).call('trial_balance', {}, ctx);

    expect(refundForTool).not.toHaveBeenCalled();
  });
});
