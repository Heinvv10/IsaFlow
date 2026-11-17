/**
 * The MCP budget tools through the REAL registry (audit and Flow metering stubbed):
 *  - every budget write tool is refused BEFORE its handler unless the token holds read:reports as well as
 *    write:budgets (review round 1: a write scope alone recovered figures through dry runs);
 *  - a service refusal THROWN by a live call (BudgetVersionError: create's name clash, the gate's stale
 *    token) reaches the agent with its own message, exactly as the dry run answers it, after the rollback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const audit = vi.hoisted(() => ({
  recordToolCall: vi.fn(async () => undefined),
  acquireIdempotencyLock: vi.fn(async () => undefined),
  findIdempotentReplay: vi.fn(async () => ({ status: 'none' as const })),
}));
vi.mock('@/lib/mcp/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/mcp/audit')>()), ...audit }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(async () => ({ ok: true as const, handle: null })), refundForTool: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn(), createVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionStatus', () => ({ transitionVersion: vi.fn() }));

import { McpRegistry } from '@/lib/mcp/registry';
import { BUDGET_WRITE_TOOLS } from '@/lib/mcp/tools/budgetToolSet';
import { createVersion, getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { transitionVersion } from '@/modules/accounting/services/budgets/budgetVersionStatus';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { BudgetVersionStaleError } from '@/modules/accounting/services/budgets/versionTake';
import { TOKEN, VERSION, ctx, text, version } from './budgetToolsFixture';

beforeEach(() => { vi.clearAllMocks(); vi.mocked(getVersion).mockResolvedValue(version() as never); });

const registryOf = (...tools: typeof BUDGET_WRITE_TOOLS) => {
  const r = new McpRegistry();
  for (const t of tools) r.register(t);
  return r;
};

describe('every budget write needs read:reports as well as write:budgets', () => {
  it.each(BUDGET_WRITE_TOOLS.map((t) => [t.name, t] as const))('%s: refused before the handler without read:reports', async (_n, tool) => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"reached"' }] }));
    const r = await registryOf({ ...tool, handler }).call(tool.name, { idempotency_key: 'k-1', dry_run: 'dry_run' in (tool.inputSchema.properties as object) ? true : undefined }, ctx('owner', ['write:budgets']));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/requires read:reports/);
    expect(handler).not.toHaveBeenCalled();
    expect(audit.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected', idempotencyKey: null }));
  });
});

describe('a thrown budget refusal reaches the agent with its own message', () => {
  it('create_budget_version: the live name clash is the service\'s message, not the generic failure', async () => {
    const tool = BUDGET_WRITE_TOOLS.find((t) => t.name === 'create_budget_version')!;
    vi.mocked(createVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_STATE', "FY2027 already has a budget version named 'Plan'"));
    const r = await registryOf(tool).call(tool.name, { fiscal_year: 2027, name: 'Plan', kind: 'scenario', idempotency_key: 'k' }, ctx());
    expect(text(r)).toBe("FY2027 already has a budget version named 'Plan'");
  });

  it('approve_budget_version with a stale version_token: the service\'s stale message', async () => {
    const tool = BUDGET_WRITE_TOOLS.find((t) => t.name === 'approve_budget_version')!;
    vi.mocked(transitionVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_STALE', 'This budget version changed since you loaded it; reload and try again'));
    const r = await registryOf(tool).call(tool.name, { version_id: VERSION, version_token: TOKEN, idempotency_key: 'k' }, ctx());
    expect(text(r)).toBe('This budget version changed since you loaded it; reload and try again');
    expect(vi.mocked(transitionVersion).mock.calls[0]![2]).toMatchObject({ expectedUpdatedAt: TOKEN });
  });

  it('the grid save\'s stale error class is a refusal code too', async () => {
    const tool = BUDGET_WRITE_TOOLS.find((t) => t.name === 'lock_budget_version')!;
    vi.mocked(transitionVersion).mockRejectedValue(new BudgetVersionStaleError(TOKEN, 'approved'));
    expect(text(await registryOf(tool).call(tool.name, { version_id: VERSION, idempotency_key: 'k' }, ctx()))).toMatch(/changed since you opened it/);
  });
});
