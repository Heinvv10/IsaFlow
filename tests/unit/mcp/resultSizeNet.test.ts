/**
 * The registry's refusal of a READ result too big for a client (resultSize.ts): the 90 KB line, the levers it names
 * (only the ones the tool's own schema has), the exemptions (writes, allowLargeResult, an error result) and the
 * accounting of a refusal (audited as rejected, Flows refunded).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const savepointMock = vi.hoisted(() => vi.fn(async (_n: string, cb: () => unknown) => cb()));

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: savepointMock, withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/mcp/audit', () => ({
  hashArgs: vi.fn(() => 'hash-1'),
  recordToolCall: vi.fn(),
  acquireIdempotencyLock: vi.fn(),
  findIdempotentReplay: vi.fn(async () => ({ status: 'none' })),
}));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(), refundForTool: vi.fn() }));

import { McpRegistry } from '@/lib/mcp/registry';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import { recordToolCall } from '@/lib/mcp/audit';
import { debitForTool, refundForTool } from '@/lib/mcp/flowMetering';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222', companyRole: 'owner',
  scopes: ['read:reports', 'write:invoices'], tokenJti: 'j', oauthAppId: null,
};
const HANDLE = { code: 'report.tb' as const, cost: 10 };
const textOfBytes = (n: number): string => 'x'.repeat(n);

function tool(over: Partial<McpTool> & { text?: string }): McpTool {
  const { text = 'ok', ...rest } = over;
  return {
    name: 'list_things',
    description: 'd',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read:reports',
    write: false,
    handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text }] })),
    ...rest,
  };
}
const call = (t: McpTool, args: Record<string, unknown> = {}) => {
  const r = new McpRegistry();
  r.register(t);
  return r.call(t.name, args, ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  savepointMock.mockImplementation(async (_n: string, cb: () => unknown) => cb());
  vi.mocked(debitForTool).mockResolvedValue({ ok: true, handle: HANDLE } as never);
});

describe('oversized read results', () => {
  it('serves a result exactly at the line and refuses one byte over', async () => {
    const at = await call(tool({ text: textOfBytes(MAX_READ_RESULT_BYTES) }));
    expect(at.isError).toBeUndefined();
    const over = await call(tool({ text: textOfBytes(MAX_READ_RESULT_BYTES + 1) }));
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toContain('list_things would return about');
  });

  it('measures bytes, not characters', async () => {
    // 'é' is 2 bytes in UTF-8: 50,000 of them is 100,000 bytes but 50,000 characters.
    const res = await call(tool({ text: 'é'.repeat(50_000) }));
    expect(res.isError).toBe(true);
  });

  it('names only the levers the tool has', async () => {
    const bare = await call(tool({ text: textOfBytes(MAX_READ_RESULT_BYTES + 1) }));
    expect(bare.content[0]!.text).toContain('narrower filters');
    expect(bare.content[0]!.text).not.toMatch(/summary|group_by|limit|compact|include_lines|date window/);

    const rich = await call(tool({
      text: textOfBytes(MAX_READ_RESULT_BYTES + 1),
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          detail: { type: 'string', enum: ['summary', 'standard'] },
          group_by: { type: 'string' },
          fields: { type: 'string', enum: ['full', 'compact'] },
          include_lines: { type: 'boolean' },
          limit: { type: 'integer' },
          from_date: { type: 'string' },
        },
      },
    }));
    const msg = rich.content[0]!.text;
    for (const lever of ['detail:"summary"', 'group_by', 'fields:"compact"', 'include_lines:false', 'smaller limit', 'date window']) {
      expect(msg, lever).toContain(lever);
    }
  });

  it('does not offer detail:"summary" to a tool whose detail has no summary level', async () => {
    const res = await call(tool({
      text: textOfBytes(MAX_READ_RESULT_BYTES + 1),
      inputSchema: { type: 'object', additionalProperties: false, properties: { detail: { type: 'string', enum: ['standard', 'full'] } } },
    }));
    expect(res.content[0]!.text).not.toContain('summary');
  });

  it('is audited as rejected (not ok) and the Flows are refunded', async () => {
    await call(tool({ text: textOfBytes(MAX_READ_RESULT_BYTES + 1) }));
    expect(vi.mocked(recordToolCall).mock.calls[0]![0]).toMatchObject({ tool: 'list_things', status: 'rejected' });
    expect(refundForTool).toHaveBeenCalledWith(ctx.companyId, HANDLE);
  });

  it('exempts a read that returns bulk content by design', async () => {
    const res = await call(tool({ text: textOfBytes(MAX_READ_RESULT_BYTES * 3), allowLargeResult: true }));
    expect(res.isError).toBeUndefined();
  });

  it('never refuses a write: its answer is what was done', async () => {
    const res = await call(
      tool({ name: 'create_thing', scope: 'write:invoices', write: true, text: textOfBytes(MAX_READ_RESULT_BYTES * 2) }),
      { idempotency_key: 'k1' },
    );
    expect(res.isError).toBeUndefined();
  });

  it('leaves a handler error alone', async () => {
    const res = await call(tool({
      handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: textOfBytes(MAX_READ_RESULT_BYTES * 2) }], isError: true })),
    }));
    expect(res.content[0]!.text).toBe(textOfBytes(MAX_READ_RESULT_BYTES * 2));
  });

  it('marks only get_document as allowed to be large, among the registered tools', async () => {
    const { MCP_TOOLS } = await import('@/lib/mcp/toolIndex');
    expect(MCP_TOOLS.filter((t) => t.allowLargeResult === true).map((t) => t.name)).toEqual(['get_document']);
  });
});
