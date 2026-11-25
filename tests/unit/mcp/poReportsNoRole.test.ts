/**
 * PO report tools, review lows: (1) po_status_report refuses a bad `from` and a bad `to` with the guard's text (no second `from` check
 * behind it); (2) the registry-agreement rule holds for a caller with no role (null / undefined companyRole), for every tool.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
// token_info lists by scope and role (synchronous); the module fence (#1656) reads per-user permissions from the database and is not part of that rule.
vi.mock('@/lib/mcp/moduleFence', () => ({ moduleFenceRefusal: vi.fn(async () => null) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/mcp/audit', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/audit')>()),
  recordToolCall: vi.fn(async () => undefined), acquireIdempotencyLock: vi.fn(async () => undefined), findIdempotentReplay: vi.fn(async () => ({ status: 'none' as const })),
}));
vi.mock('@/lib/mcp/flowMetering', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/flowMetering')>()),
  debitForTool: vi.fn(async () => ({ ok: true as const, handle: null })), refundForTool: vi.fn(async () => undefined),
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: vi.fn(async () => ({ name: 'Acme' })) }));
vi.mock('@/modules/accounting/services/practice/practiceUsersService', () => ({ getCompanyUser: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/ap/poStatusReport', async (orig) => ({ ...(await orig<object>()), readPoStatusReport: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/committedSpend', async (orig) => { const real = await orig<typeof import('@/modules/accounting/services/budgets/committedSpend')>(); return { ...real, committedSpendReport: vi.fn(real.committedSpendReport) }; });
vi.mock('@/modules/accounting/services/budgets/remainingCommitted', async (orig) => ({ ...(await orig<object>()), readCommitmentLines: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({ ...(await orig<object>()), loadChartRefs: vi.fn(async () => ({ accounts: [], members: [] })) }));

import { McpRegistry } from '@/lib/mcp/registry';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { poStatusReportTool } from '@/lib/mcp/tools/poStatusReportTool';
import { readPoStatusReport } from '@/modules/accounting/services/ap/poStatusReport';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = (scopes: string[], companyRole?: string | null): McpToolContext => ({ userId: 'u-1', companyId: '22222222-2222-2222-2222-222222222222', tokenJti: 'j', oauthAppId: null, companyRole, scopes });
const ALL_SCOPES = [...new Set(MCP_TOOLS.flatMap((t) => [t.scope, ...(t.anyOfScopes ?? []), t.requiresScope, t.requiresPost ? 'write:post' : null]).filter((s): s is string => !!s))];

describe('po_status_report date arguments', () => {
  it.each([
    ['from', { from: '2026-02-31' }, 'invalid from'],
    ['from junk', { from: 'yesterday' }, 'invalid from'],
    ['to', { to: '2026-02-31' }, 'invalid to'],
    ['to junk', { to: 'tomorrow' }, 'invalid to'],
  ])('refuses a bad %s before reading anything', async (_n, args, text) => {
    vi.mocked(readPoStatusReport).mockClear();
    const r = await poStatusReportTool.handler(args, ctx(['read:invoices'], 'owner'));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(text);
    expect(readPoStatusReport).not.toHaveBeenCalled();
  });
});

describe('registry agreement for a caller with no role', () => {
  it.each([[null], [undefined]])('companyRole %s: listed exactly when a call gets past the fences and the tool\'s own `admits`', async (role) => {
    for (const scopes of [ALL_SCOPES, ['read:reports'], ['read:invoices'], ['read:reports', 'read:invoices']]) {
      const out = JSON.parse((await MCP_TOOLS.find((t) => t.name === 'token_info')!.handler({}, ctx(scopes, role))).content[0]!.text) as { tools: Record<string, string[]>; tools_without_scope: string[] };
      const listed = new Set([...Object.values(out.tools).flat(), ...out.tools_without_scope]);
      for (const tool of MCP_TOOLS) {
        const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
        const registry = new McpRegistry();
        registry.register({ ...tool, handler });
        const r = await registry.call(tool.name, { idempotency_key: 'k' }, ctx(scopes, role));
        const passes = !r.isError && handler.mock.calls.length === 1;
        const admitted = tool.admits === undefined || tool.admits(role ?? null);
        expect(listed.has(tool.name), `${tool.name} as ${String(role)} with ${scopes.length} scopes`).toBe(passes && admitted);
      }
    }
  });

  it('every tool that declares `admits` is decided for a missing role, and refuses it when it says no', async () => {
    const declared = MCP_TOOLS.filter((t) => t.admits !== undefined);
    expect(declared.length).toBeGreaterThan(0);
    for (const tool of declared) {
      expect(typeof tool.admits!(null), tool.name).toBe('boolean');
      expect(tool.admits!(null), `${tool.name} admits(null) must match admits(undefined)`).toBe(tool.admits!(undefined as unknown as null));
    }
    for (const name of ['committed_spend', 'budget_remaining']) {
      expect(MCP_TOOLS.find((t) => t.name === name)!.admits!(null), name).toBe(false);
    }
  });
});
