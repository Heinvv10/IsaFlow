// Durable invocation lifecycle is exercised separately by registryInvocation and PostgreSQL suites.
vi.mock('@/lib/mcp/invocationBoundary', () => ({ withMcpInvocation: async (_name: string, _args: unknown, run: (mark: () => void) => Promise<unknown>) => run(() => undefined) }));
// Tool argument contracts are independently covered for every registered schema.
vi.mock('@/lib/mcp/inputValidation', () => ({ validateToolArguments: (_tool: unknown, args: unknown) => ({ ok: true, args }) }));
// Current authority is independently covered by forensic/currentToolAuthority and real PostgreSQL permission tests.
vi.mock('@/lib/mcp/currentToolAuthority', () => ({ assertCurrentToolAuthority: vi.fn(async () => undefined) }));
/**
 * The assert-only `company_id`.
 *
 * The invariant this protects is subtle and easy to break by "improving" it:
 * the argument must NEVER be able to change which company a write lands on. It
 * may only compare the caller's belief with the token's company and refuse.
 *
 * So the tests below are not about the happy path. They are about proving the
 * argument is inert as a selector: a mismatch refuses BEFORE the handler runs,
 * a match changes nothing, and the scope the handler sees is always ctx's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
    withSavepoint: vi.fn((_n: string, fn: () => Promise<unknown>) => fn()),
  };
});
vi.mock('@/lib/mcp/audit', () => ({
  recordToolCall: vi.fn(),
  findIdempotentReplay: vi.fn(async () => ({ status: 'none' })),
  acquireIdempotencyLock: vi.fn(),
  hashArgs: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/mcp/flowMetering', () => ({
  flowOperationFor: vi.fn(() => null),
  debitForTool: vi.fn(async () => ({ ok: true, handle: null })),
  refundForTool: vi.fn(),
}));

import { McpRegistry } from '@/lib/mcp/registry';
import { assertCompanyMatches } from '@/lib/mcp/companyAssert';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['write:things', 'write:post'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}

/** Records the companyId the handler actually saw. */
function spyTool(): { tool: McpTool; seen: string[] } {
  const seen: string[] = [];
  const tool: McpTool = {
    name: 'spy_write',
    description: 'x'.repeat(30),
    scope: 'write:things',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { idempotency_key: { type: 'string' } },
      required: ['idempotency_key'],
      additionalProperties: false,
    },
    handler: async (_args, c) => {
      seen.push(c.companyId);
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
  };
  return { tool, seen };
}

beforeEach(() => vi.clearAllMocks());

describe('assertCompanyMatches (unit)', () => {
  it('passes when absent, null, or matching', () => {
    expect(assertCompanyMatches({}, COMPANY)).toBeNull();
    expect(assertCompanyMatches({ company_id: null }, COMPANY)).toBeNull();
    expect(assertCompanyMatches({ company_id: COMPANY }, COMPANY)).toBeNull();
  });

  it('refuses a mismatch and names BOTH ids so the agent can correct itself', () => {
    const r = assertCompanyMatches({ company_id: OTHER }, COMPANY)!;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(OTHER);
    expect(r.content[0]!.text).toContain(COMPANY);
    expect(r.content[0]!.text).toMatch(/[Nn]othing was written/);
  });

  it('refuses a malformed assertion AS malformed, not as a mismatch', () => {
    // Both branches refuse, so asserting only `isError` proves nothing — it
    // passes with the type guard deleted. The MESSAGE is the difference that
    // matters: "invalid company_id" tells the agent it sent the wrong SHAPE,
    // while the mismatch text tells it it named the wrong COMPANY, and sends
    // it to list_companies to fix a problem it does not have.
    for (const bad of ['not-a-uuid', 123, [], {}, true]) {
      const r = assertCompanyMatches({ company_id: bad }, COMPANY);
      expect(r?.isError, `expected refusal for ${JSON.stringify(bad)}`).toBe(true);
      expect(r!.content[0]!.text, `for ${JSON.stringify(bad)}`).toBe('invalid company_id');
    }
  });
});

describe('registry fence', () => {
  it('refuses a mismatched company_id WITHOUT running the handler', async () => {
    const { tool, seen } = spyTool();
    const reg = new McpRegistry();
    reg.register(tool);

    const r = await reg.call('spy_write', { company_id: OTHER, idempotency_key: 'k1' }, ctx());
    expect(r.isError).toBe(true);
    // The load-bearing assertion: the write never happened.
    expect(seen).toEqual([]);
  });

  it('lets a matching assertion through, and the handler still sees ctx company', async () => {
    const { tool, seen } = spyTool();
    const reg = new McpRegistry();
    reg.register(tool);

    const r = await reg.call('spy_write', { company_id: COMPANY, idempotency_key: 'k2' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(seen).toEqual([COMPANY]);
  });

  it('CANNOT redirect a write — the handler sees ctx company, never the argument', async () => {
    // The whole point. Even the value that IS accepted is only ever compared;
    // there is no path by which args.company_id becomes the scope.
    const { tool, seen } = spyTool();
    const reg = new McpRegistry();
    reg.register(tool);

    await reg.call('spy_write', { company_id: COMPANY, idempotency_key: 'k3' }, ctx());
    expect(seen).toEqual([COMPANY]);
    expect(seen).not.toContain(OTHER);
  });

  it('does not fence READS — a read against the wrong company is self-correcting', async () => {
    const seen: string[] = [];
    const reg = new McpRegistry();
    reg.register({
      name: 'spy_read',
      description: 'x'.repeat(30),
      scope: null,
      write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_a, c) => {
        seen.push(c.companyId);
        return { content: [{ type: 'text', text: '{}' }] };
      },
    });

    const r = await reg.call('spy_read', { company_id: OTHER }, ctx());
    expect(r.isError).toBeFalsy();
    expect(seen).toEqual([COMPANY]);
  });

  it('refuses BEFORE the idempotency-key check, so a mismatch never burns a key', async () => {
    const { tool, seen } = spyTool();
    const reg = new McpRegistry();
    reg.register(tool);

    // No idempotency_key at all: if the company fence ran second, the reply
    // would be the key error instead.
    const r = await reg.call('spy_write', { company_id: OTHER }, ctx());
    expect(r.content[0]!.text).toContain('does not match');
    expect(r.content[0]!.text).not.toContain('idempotency_key is required');
    expect(seen).toEqual([]);
  });
});
