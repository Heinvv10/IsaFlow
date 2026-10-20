/**
 * Audit 2026-10-18 S-01 — every MCP write tool answers to the caller's ROLE in the company, not only to
 * the token's scopes. A viewer could mint a token with write:post and post journals or close periods.
 * Through the real registry, for every registered write tool: a viewer-bound token holding every scope
 * is refused before the handler runs; an owner/admin/manager-bound token reaches it. The census half
 * fails when a tool that needs a write scope is declared `write: false`, which would slip past the fence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(async () => []), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const audit = vi.hoisted(() => ({
  recordToolCall: vi.fn(async () => undefined),
  acquireIdempotencyLock: vi.fn(async () => undefined),
  findIdempotentReplay: vi.fn(async () => ({ status: 'none' as const })),
}));
vi.mock('@/lib/mcp/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/mcp/audit')>()), ...audit }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(async () => ({ ok: true as const, handle: null })), refundForTool: vi.fn(async () => undefined) }));

import { McpRegistry } from '@/lib/mcp/registry';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { OAUTH_SCOPES } from '@/lib/auth/oauthScopes';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const ctxFor = (companyRole: string | null | undefined): McpToolContext => ({
  userId: 'u-1', companyId: COMPANY, tokenJti: 'j', oauthAppId: null, companyRole, scopes: [...OAUTH_SCOPES],
});
const ALL: McpTool[] = [...MCP_TOOLS];
const WRITES = ALL.filter((t) => t.write);
const READS = ALL.filter((t) => !t.write && !t.requiresWriteRole);

function registryWith(tool: McpTool) {
  const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"reached"' }] }));
  const registry = new McpRegistry();
  registry.register({ ...tool, handler });
  return { registry, handler };
}

beforeEach(() => vi.clearAllMocks());

describe('MCP write-tool role fence (S-01)', () => {
  it('the census sees the write tools (a broken import would make every case below vacuous)', () => {
    expect(WRITES.length).toBeGreaterThan(80);
    expect(WRITES.map((t) => t.name)).toEqual(expect.arrayContaining(['post_journal', 'close_fiscal_period', 'year_end_close', 'void_payment']));
  });

  it.each(WRITES.map((t) => [t.name, t] as const))('%s: a viewer-bound token with every scope is refused, handler never runs', async (_n, tool) => {
    const { registry, handler } = registryWith(tool);
    for (const role of ['viewer', 'storeman', 'technician', null, undefined]) {
      const r = await registry.call(tool.name, { idempotency_key: 'k-1' }, ctxFor(role));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/owner, admin and manager/);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(WRITES.map((t) => [t.name, t] as const))('%s: an owner/admin/manager-bound token reaches the handler', async (_n, tool) => {
    for (const role of ['owner', 'admin', 'manager']) {
      const { registry, handler } = registryWith(tool);
      const r = await registry.call(tool.name, { idempotency_key: `k-${role}` }, ctxFor(role));
      expect(r.isError, r.content[0]?.text).toBeFalsy();
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it('a read tool stays open to a viewer', async () => {
    const tool = READS.find((t) => t.name === 'trial_balance')!;
    const { registry, handler } = registryWith(tool);
    const r = await registry.call(tool.name, {}, ctxFor('viewer'));
    expect(r.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('census: a tool named like a write is declared write: true (the fence keys off `write`)', () => {
    // Verbs every current write tool starts with. A read tool may not take one; suggest_/propose_ return a plan.
    const WRITE_VERB = /^(allocate|apply|approve|assign|attach|auto|bulk|calculate|cancel|close|create|deactivate|delete|disable|end|finalize|import|link|lock|log|mark|merge|perform|post|reopen|reverse|run|set|settle|split|submit|sync|tag|take|unapply|undo|update|void|year|add|remove|send|write|record|clear|reset|restore|archive|edit|change|move|pay|issue|generate)_/;
    const misdeclared = ALL.filter((t) => !t.write && WRITE_VERB.test(t.name)).map((t) => t.name);
    expect(misdeclared).toEqual([]);
  });

  it('census: a tool that needs a write scope or write:post is declared write: true', () => {
    const needsWrite = (t: McpTool) =>
      Boolean(t.requiresPost) || [t.scope, t.requiresScope].some((s) => typeof s === 'string' && s.startsWith('write:'));
    const undeclared = ALL.filter((t) => needsWrite(t) && !t.write).map((t) => t.name);
    expect(undeclared).toEqual([]);
  });
});
