/**
 * The other MCP budget tools' own half: the owner gate on approve / lock / unlock / set primary (ruling 2:
 * every non-owner role refused BEFORE the service), version ownership (shared Not found), create / copy /
 * seed / restore argument refusals and dry runs, the reads' figures and paging, and the registration census
 * (manifest, client list, Flow metering: every budget tool free).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({
  getVersion: vi.fn(), listVersions: vi.fn(), createVersion: vi.fn(), copyVersion: vi.fn(), setPrimary: vi.fn(),
}));
vi.mock('@/modules/accounting/services/budgets/budgetVersionStatus', () => ({ transitionVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionActivity', () => ({ lastEditsOf: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/seedVersion', () => ({ seedVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', () => ({ planRestore: vi.fn(), restoreSnapshot: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { copyVersion, getVersion, listVersions, setPrimary } from '@/modules/accounting/services/budgets/budgetVersions';
import { transitionVersion } from '@/modules/accounting/services/budgets/budgetVersionStatus';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { seedVersion } from '@/modules/accounting/services/budgets/seedVersion';
import { planRestore, restoreSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { BUDGET_GATE_TOOLS } from '@/lib/mcp/tools/budgetGateTools';
import { createBudgetVersionTool } from '@/lib/mcp/tools/budgetVersionTools';
import { seedBudgetTool } from '@/lib/mcp/tools/budgetSeedTool';
import { restoreBudgetVersionTool } from '@/lib/mcp/tools/budgetRestoreTool';
import { getBudgetTool, listBudgetVersionsTool } from '@/lib/mcp/tools/budgetReadTools';
import { BUDGET_READ_TOOLS, BUDGET_WRITE_TOOLS } from '@/lib/mcp/tools/budgetToolSet';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { RENT, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model());
});

const args = { version_id: VERSION, idempotency_key: 'k', reason: 'Year-end correction' };

describe('the owner gate (ruling 2)', () => {
  it.each(BUDGET_GATE_TOOLS.map((t) => [t.name, t] as const))('%s: admin, manager, viewer and no role are refused before any service', async (_n, tool) => {
    for (const role of ['admin', 'manager', 'viewer', null]) {
      const r = await tool.handler(args, ctx(role));
      expect(text(r)).toBe('A person must approve this budget in ISAFlow');
    }
    expect(getVersion).not.toHaveBeenCalled();
    expect(transitionVersion).not.toHaveBeenCalled();
    expect(setPrimary).not.toHaveBeenCalled();
  });

  it('the owner reaches the service as the owner, with the token as the compare-and-set', async () => {
    vi.mocked(transitionVersion).mockResolvedValue(version({ status: 'approved' }) as never);
    const approve = BUDGET_GATE_TOOLS.find((t) => t.name === 'approve_budget_version')!;
    const r = await approve.handler({ ...args, version_token: TOKEN, force: true }, ctx('owner'));
    expect(json(r)).toMatchObject({ version: { status: 'approved' } });
    expect(transitionVersion).toHaveBeenCalledWith(expect.anything(), VERSION,
      { action: 'approve', reason: 'Year-end correction', expectedUpdatedAt: TOKEN, force: true }, { userId: 'u-1', role: 'owner' });
  });

  it("an owner naming another company's version gets the shared Not found", async () => {
    vi.mocked(getVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    const lock = BUDGET_GATE_TOOLS.find((t) => t.name === 'lock_budget_version')!;
    expect(text(await lock.handler(args, ctx('owner')))).toBe('Not found');
    expect(transitionVersion).not.toHaveBeenCalled();
  });
});

describe('create / seed / restore', () => {
  it('create with copy_from_version_id of another year is refused (a copy stays in its year)', async () => {
    const r = await createBudgetVersionTool.handler({ fiscal_year: 2028, name: 'X', kind: 'scenario', copy_from_version_id: VERSION, idempotency_key: 'k' }, ctx());
    expect(text(r)).toMatch(/FY2027 version.*seed_budget/);
    expect(copyVersion).not.toHaveBeenCalled();
  });

  it.each([
    [{ uplift_pct: 2000 }, /uplift_pct/],
    [{ uplift_pct: 1.00001 }, /uplift_pct/],
    [{ section_uplifts: [{ section: 'payroll', uplift_pct: 1 }] }, /section must be one of/],
    [{ fixed_annual: [{ account: '6000', amount: 100 }] }, /decimal strings/],
    [{ rounding_unit: 10 }, /rounding_unit/],
    [{ source: 'blank' }, /source must be/],
  ])('seed refuses %j before seeding', async (extra, why) => {
    const r = await seedBudgetTool.handler({ fiscal_year: 2027, name: 'S', kind: 'scenario', source: 'prior_year_actuals', idempotency_key: 'k', ...extra }, ctx());
    expect(text(r)).toMatch(why);
    expect(seedVersion).not.toHaveBeenCalled();
  });

  it('seed dry run runs the real seed rolled back and frees the key; adjustments reach the service resolved to ids', async () => {
    vi.mocked(seedVersion).mockResolvedValue({ versionId: 'v-new', updatedAt: TOKEN, cells: 12, skippedAccounts: 0 });
    const r = await seedBudgetTool.handler({
      fiscal_year: 2027, name: 'S', kind: 'scenario', source: 'prior_year_actuals', uplift_pct: 5, dry_run: true, idempotency_key: 'k',
      account_uplifts: [{ account: '6000', uplift_pct: 10 }], fixed_annual: [{ account: '4000', amount: '1200.00' }], seasonality: 'flat',
    }, ctx());
    expect(r.wroteNothing).toBe(true);
    const input = vi.mocked(seedVersion).mock.calls[0]![2];
    expect(input).toMatchObject({ makePrimary: false, source: { type: 'py_actuals', upliftPct: 5 } });
    expect([...input.adjust!.accountUplift!]).toEqual([[RENT, 10]]);
    expect(input.adjust!.seasonality).toBe('flat');
  });

  it('restore refused when the version changed since names the differing cells (no amounts without read:reports)', async () => {
    vi.mocked(planRestore).mockResolvedValue({ ok: false, reason: 'The budget changed since that write (snapshot s): 1 of its 2 cells differ now', differing: [{ cell: { a: RENT, c1: null, c2: null, b: null, m: '2026-04', before: null, after: '5.00' }, now: '7.00' }], differingCount: 1 });
    const r = await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx('owner', ['write:budgets']));
    expect(text(r)).toMatch(/1 of its 2 cells differ now.*2026-04/);
    expect(text(r)).not.toMatch(/7\.00|5\.00/);
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  it('restore dry run runs the restore rolled back and frees the key', async () => {
    vi.mocked(planRestore).mockResolvedValue({ ok: true, snapshot: { id: 's', tool: 'set_budget_amounts', createdAt: TOKEN, createdBy: 'u-1' }, tokenAfter: TOKEN, cells: [] });
    const r = await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k', dry_run: true }, ctx());
    expect(r.wroteNothing).toBe(true);
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('reads', () => {
  it('list_budget_versions: totals as decimal text', async () => {
    vi.mocked(listVersions).mockResolvedValue([version({ total: 1234.5 })] as never);
    expect(json(await listBudgetVersionsTool.handler({}, ctx('viewer', ['read:reports'])))).toMatchObject({ items: [{ total: '1234.50', version_token: TOKEN, last_edit: null }] });
  });

  it('get_budget: rows per account and level, months as decimal text, a viewer gets no per_head rate', async () => {
    vi.mocked(loadGridReadModel).mockResolvedValue(model());
    const out = json(await getBudgetTool.handler({ version_id: VERSION, include_drivers: true }, ctx('viewer', ['read:reports'])));
    expect(out.rows).toEqual([{ account: '6000', account_name: 'Rent', account_id: RENT, section: 'operating_expense', level: 'company', member: null, months: { '2026-03': '100.00' }, total: '100.00' }]);
    expect(vi.mocked(loadGridReadModel).mock.calls[0]![2]).toBe('totals');
    expect(out.version_token).toBe(TOKEN);
  });

  it('get_budget refuses an account filter it cannot resolve', async () => {
    expect(text(await getBudgetTool.handler({ version_id: VERSION, accounts: ['nope'] }, ctx()))).toMatch(/accounts: "nope"/);
  });
});

describe('registration', () => {
  const names = [...BUDGET_READ_TOOLS, ...BUDGET_WRITE_TOOLS].map((t) => t.name);
  it('fourteen tools, all registered, listed for clients, free, reads read-only and writes write:budgets', () => {
    expect(names).toHaveLength(14);
    for (const n of names) {
      expect(MCP_TOOLS.some((t) => t.name === n)).toBe(true);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
      expect(flowOperationFor(n)).toBeNull();
    }
    expect(BUDGET_READ_TOOLS.every((t) => !t.write && t.scope === 'read:reports')).toBe(true);
    expect(BUDGET_WRITE_TOOLS.every((t) => t.write && t.scope === 'write:budgets' && 'idempotency_key' in (t.inputSchema.properties as object))).toBe(true);
  });
});
