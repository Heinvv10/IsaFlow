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
  getVersion: vi.fn(), listVersions: vi.fn(), createVersion: vi.fn(), copyVersion: vi.fn(), setPrimary: vi.fn(), deleteVersion: vi.fn(),
}));
vi.mock('@/modules/accounting/services/budgets/budgetVersionStatus', () => ({ transitionVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionActivity', () => ({ lastEditsOf: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/seedVersion', () => ({ seedVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetSnapshotRestore', () => ({ planRestore: vi.fn(), restoreSnapshot: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { deleteVersion, getVersion, listVersions, setPrimary } from '@/modules/accounting/services/budgets/budgetVersions';
import { transitionVersion } from '@/modules/accounting/services/budgets/budgetVersionStatus';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { seedVersion } from '@/modules/accounting/services/budgets/seedVersion';
import { planRestore, restoreSnapshot } from '@/modules/accounting/services/budgets/budgetSnapshotRestore';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { BUDGET_GATE_TOOLS } from '@/lib/mcp/tools/budgetGateTools';
import { deleteBudgetVersionTool } from '@/lib/mcp/tools/budgetDeleteTool';
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
      expect(text(r)).toBe('A person must approve this budget in IsaFlow');
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
  it("delete_budget_version: another company's version is Not found; the dry run deletes nothing and frees the key", async () => {
    vi.mocked(getVersion).mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    expect(text(await deleteBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx()))).toBe('Not found');
    expect(deleteVersion).not.toHaveBeenCalled();
    const dry = await deleteBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k', dry_run: true }, ctx());
    expect([dry.wroteNothing, json(dry).dry_run]).toEqual([true, true]);
    vi.mocked(deleteVersion).mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_STATE', 'The primary budget cannot be deleted; make another version primary first'));
    expect(text(await deleteBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k', dry_run: true }, ctx()))).toMatch(/would be refused: The primary budget/);
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
    vi.mocked(seedVersion).mockResolvedValue({ versionId: 'v-new', updatedAt: TOKEN, cells: 12, skippedAccounts: 0, roundingFlips: ['6000 Rent'] });
    const r = await seedBudgetTool.handler({
      fiscal_year: 2027, name: 'S', kind: 'scenario', source: 'prior_year_actuals', uplift_pct: 5, dry_run: true, idempotency_key: 'k',
      account_uplifts: [{ account: '6000', uplift_pct: 10 }], fixed_annual: [{ account: '4000', amount: '1200.00' }], seasonality: 'flat',
    }, ctx());
    expect(r.wroteNothing).toBe(true);
    expect(json(r)).toMatchObject({ rounding_flips: ['6000 Rent'], rounding_flips_total: 1 });
    const input = vi.mocked(seedVersion).mock.calls[0]![2];
    expect(input).toMatchObject({ makePrimary: false, source: { type: 'py_actuals', upliftPct: 5 } });
    expect([...input.adjust!.accountUplift!]).toEqual([[RENT, 10]]);
    expect(input.adjust!.seasonality).toBe('flat');
  });

  it('restore refused when the version changed since names the differing cells; nothing restored', async () => {
    vi.mocked(planRestore).mockResolvedValue({ ok: false, reason: 'The budget changed since that write (snapshot s): 1 of its 2 cells differ now', differing: [{ cell: { a: RENT, c1: null, c2: null, b: null, m: '2026-04', before: null, after: '5.00', bs: null, as: 'manual' }, now: '7.00', nowSource: 'manual' }], differingCount: 1 });
    const r = await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx());
    expect(text(r)).toMatch(/1 of its 2 cells differ now.*2026-04.*"now":"7.00"/);
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  const plan = (n: number) => ({
    ok: true as const, snapshot: { id: 's', tool: 'set_budget_amounts', createdAt: TOKEN, createdBy: 'u-1' }, token: TOKEN, planHash: 'b'.repeat(64), snapshotCells: [],
    cells: Array.from({ length: n }, (_, i) => ({ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: `2026-0${i + 3}`, amount: 1 })),
  });

  it('restore dry run runs the restore rolled back, answers the plan_hash and frees the key', async () => {
    vi.mocked(planRestore).mockResolvedValue(plan(2));
    const r = await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k', dry_run: true }, ctx());
    expect([r.wroteNothing, json(r).plan_hash]).toEqual([true, 'b'.repeat(64)]);
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('a live restore of more than one cell needs the dry run\'s plan_hash, and refuses another', async () => {
    vi.mocked(planRestore).mockResolvedValue(plan(2));
    expect(text(await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx()))).toMatch(/plan_hash is required/);
    expect(text(await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k', plan_hash: 'c'.repeat(64) }, ctx()))).toMatch(/plan changed/);
    expect(restoreSnapshot).not.toHaveBeenCalled();
    vi.mocked(restoreSnapshot).mockResolvedValue({ updatedAt: TOKEN, saved: 2, deleted: 0 });
    expect(json(await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k', plan_hash: 'b'.repeat(64) }, ctx()))).toMatchObject({ restored: 2 });
  });

  it('the restore is planned for the token user and role (the author, or an owner or admin)', async () => {
    vi.mocked(planRestore).mockResolvedValue({ ok: false, reason: 'Only the person whose connection made that write, or an owner or admin, can restore it' });
    expect(text(await restoreBudgetVersionTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx('manager')))).toMatch(/Only the person whose connection made that write/);
    expect(vi.mocked(planRestore).mock.calls[0]![4]).toEqual({ userId: 'u-1', role: 'manager' });
  });
});

describe('reads', () => {
  it('list_budget_versions: totals as decimal text', async () => {
    vi.mocked(listVersions).mockResolvedValue([version({ total: 1234.5 })] as never);
    expect(json(await listBudgetVersionsTool.handler({}, ctx('viewer', ['read:reports'])))).toMatchObject({ items: [{ total: '1234.50', version_token: TOKEN, last_edit: null }], total: 1, next_offset: null });
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
  it('fifteen tools, all registered, listed for clients, free; reads need read:reports, writes write:budgets AND read:reports', () => {
    expect(names).toHaveLength(15);
    for (const n of names) {
      expect(MCP_TOOLS.some((t) => t.name === n)).toBe(true);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
      expect(flowOperationFor(n)).toBeNull();
    }
    expect(BUDGET_READ_TOOLS.every((t) => !t.write && t.scope === 'read:reports')).toBe(true);
    expect(BUDGET_WRITE_TOOLS.every((t) => t.write && t.scope === 'write:budgets' && t.requiresScope === 'read:reports' && 'idempotency_key' in (t.inputSchema.properties as object))).toBe(true);
  });
});
