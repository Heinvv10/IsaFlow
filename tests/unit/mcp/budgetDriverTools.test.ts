/**
 * set_budget_drivers and get_budget_drivers (MCP budget tools PR 3), services mocked:
 *  - every pre-write refusal (shape, op, month, amount as a number, two dimensions: decision 14, an account the
 *    resolver refuses, a row with no driver to delete, a malformed hire id) is per change and writes nothing;
 *  - the dry run runs the REAL driver services in a rolled-back savepoint, answers the cells they left (recomputed
 *    dependents included), the driver lines and hires before / after and a plan_hash, and frees the key;
 *  - live: plan_hash required (always), a stale version_token or a moved plan refused, the services called in
 *    order with the token chained, a snapshot of every changed cell recorded as set_budget_drivers;
 *  - a service refusal (decision 4's DRIVER_REF, a cycle) is answered with its change index; after a write it throws;
 *  - get_budget_drivers: per-head rates and headcount only for budget writers (#979), through the services' access.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn(), loadGridCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverWriteService', () => ({
  saveDriver: vi.fn(), deleteDriver: vi.fn(), resetOverride: vi.fn(), refreshHeadcount: vi.fn(), listDrivers: vi.fn(),
}));
vi.mock('@/modules/accounting/services/budgets/drivers/plannedHireService', () => ({
  createHire: vi.fn(), updateHire: vi.fn(), deleteHire: vi.fn(), listHires: vi.fn(), readHeadcount: vi.fn(),
}));
vi.mock('@/modules/accounting/services/budgets/drivers/driverRepository', () => ({ listDriverLines: vi.fn(async () => []), listPlannedHires: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', async (orig) => ({ ...(await orig<object>()), recordSnapshot: vi.fn(async () => 'snap-1') }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { deleteDriver, listDrivers, refreshHeadcount, saveDriver } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { createHire, listHires, readHeadcount } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import { listDriverLines } from '@/modules/accounting/services/budgets/drivers/driverRepository';
import { recordSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { visibleDriverLines } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import { BudgetDriverError } from '@/modules/accounting/services/budgets/drivers/driverErrors';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { setBudgetDriversTool, MAX_DRIVER_CHANGES } from '@/lib/mcp/tools/budgetDriverWrite';
import { getBudgetDriversTool } from '@/lib/mcp/tools/budgetDriverRead';
import { CC1, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';

const T2 = '2026-11-16T10:00:05.000001Z';
const cell = (month: string, amount: number, source = 'manual') => ({ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month, amount, source });
const BEFORE = [cell('2026-03', 100)];
const AFTER = [cell('2026-03', 250, 'driver'), cell('2026-04', 250, 'driver'), cell('2026-05', 250, 'driver')];
const outcome = (over: Record<string, unknown> = {}) => ({ updatedAt: T2, recomputed: 3, warnings: [], headcountAsOf: null, ...over });
const fixed = { op: 'set_driver', account: '6000', kind: 'fixed', amount: '250.00', from_month: '2026-03', to_month: '2026-05' };
const base = { version_id: VERSION, idempotency_key: 'k' };
const stored = (over: Record<string, unknown> = {}) => ({
  id: 'd-1', updatedAt: TOKEN, glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, kind: 'fixed', fromMonth: '2026-03', toMonth: '2026-05',
  amount: 250, pct: null, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: null, rounding: 1, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model());
  vi.mocked(loadGridCells).mockImplementation(async () => ({ versionId: VERSION, updatedAt: TOKEN, cells: BEFORE }) as never);
  vi.mocked(saveDriver).mockResolvedValue(outcome({ driver: stored() }) as never);
  vi.mocked(createHire).mockResolvedValue(outcome({ hire: { id: 'h-1' }, updatedAt: '2026-11-16T10:00:06.000001Z' }) as never);
});

/** The dry run's (or live write's) services leave AFTER: the second cell read is inside the savepoint. */
const afterSave = () => vi.mocked(loadGridCells)
  .mockResolvedValueOnce({ versionId: VERSION, updatedAt: TOKEN, cells: BEFORE } as never)
  .mockResolvedValueOnce({ versionId: VERSION, updatedAt: T2, cells: AFTER } as never);

describe('set_budget_drivers: refusals before any service (each per change, nothing written)', () => {
  it.each([
    [{ changes: [] }, /at least one change/],
    [{ changes: Array(MAX_DRIVER_CHANGES + 1).fill({ op: 'refresh_headcount' }) }, /at most 50/],
    [{ changes: [fixed], plan_hash: 'nope' }, /plan_hash must be/],
    [{ changes: [fixed], version_token: 'x' }, /version_token must be/],
  ])('%j', async (extra, why) => {
    expect(text(await setBudgetDriversTool.handler({ ...base, ...extra }, ctx()))).toMatch(why);
    expect(saveDriver).not.toHaveBeenCalled();
  });

  it.each([
    [{ op: 'rename' }, /op must be one of/],
    [{ ...fixed, from_month: '2026-3' }, /from_month must be YYYY-MM/],
    [{ ...fixed, amount: 250 }, /decimal strings/],
    [{ ...fixed, cc1: 'C1', bu: 'B' }, /at most one dimension.*decision 14/],
    [{ ...fixed, account: '7000' }, /header account/],
    [{ ...fixed, account: 'nope' }, /not an account of this company/],
    [{ ...fixed, kind: 'pct_of_line', amount: undefined, pct: 10 }, /pct_of_line driver needs ref/],
    [{ ...fixed, colour: 'red' }, /colour is not a field of set_driver/],
    [{ op: 'delete_driver', account: '6000' }, /has no driver to delete/],
    [{ op: 'update_hire', hire_id: 'h', label: 'x', start_month: '2026-03' }, /hire_id must be/],
  ])('change %j is refused with its reason; the dry run lists it and writes nothing', async (change, why) => {
    const r = await setBudgetDriversTool.handler({ ...base, changes: [change], dry_run: true }, ctx());
    const out = json(r);
    expect(out).toMatchObject({ ready: false, plan_hash: null });
    expect(JSON.stringify(out.refusals)).toMatch(why);
    expect(r.wroteNothing).toBe(true);
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
  });

  it('live, a refused change refuses the call (all or nothing)', async () => {
    const r = await setBudgetDriversTool.handler({ ...base, changes: [fixed, { op: 'rename' }], plan_hash: 'a'.repeat(64) }, ctx());
    expect(text(r)).toMatch(/1 change is refused, so nothing was written.*change 1: op must be one of/);
    expect(saveDriver).not.toHaveBeenCalled();
  });
});

describe('set_budget_drivers: dry run', () => {
  it('runs the real services rolled back, answers what they left (dependents included) and a plan_hash, frees the key', async () => {
    afterSave();
    const r = await setBudgetDriversTool.handler({ ...base, changes: [fixed], dry_run: true }, ctx());
    expect(r.wroteNothing).toBe(true);
    const out = json(r);
    expect(out).toMatchObject({ dry_run: true, ready: true, version_token: TOKEN, counts: { added: 2, changed: 1, removed: 0 } });
    expect(out.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: '6000', month: '2026-03', status: 'changed', before: '100.00', after: '250.00', source: 'driver' }),
    ]));
    expect(saveDriver).toHaveBeenCalledWith(expect.anything(), 'u-1', { versionId: VERSION, expectedUpdatedAt: TOKEN },
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, kind: 'fixed', fromMonth: '2026-03', toMonth: '2026-05', rounding: 1, amount: 250 });
    expect(recordSnapshot).not.toHaveBeenCalled();
  });

  it('a service refusal is answered with its change index (decision 4: the driver at another grain)', async () => {
    vi.mocked(saveDriver).mockRejectedValue(new BudgetDriverError('DRIVER_REF', '6000 Rent is budgeted at company level in this version; a driver at CC1 would put it at two levels'));
    const r = await setBudgetDriversTool.handler({ ...base, changes: [{ ...fixed, cc1: 'C1' }], dry_run: true }, ctx());
    expect(text(r)).toMatch(/would be refused: change 0 \(set_driver\): 6000 Rent is budgeted at company level/);
    expect(saveDriver).toHaveBeenCalledWith(expect.anything(), 'u-1', expect.anything(), expect.objectContaining({ cc1Id: CC1 }));
  });

  it('a change set that would change more than MAX_SAVE_CELLS cells is refused, never chunked', async () => {
    const many = Array.from({ length: 20_001 }, (_, i) => ({ ...cell(`2026-03`, 1), glAccountId: `a${i}` }));
    vi.mocked(loadGridCells).mockResolvedValueOnce({ versionId: VERSION, updatedAt: TOKEN, cells: [] } as never)
      .mockResolvedValueOnce({ versionId: VERSION, updatedAt: T2, cells: many } as never);
    expect(text(await setBudgetDriversTool.handler({ ...base, changes: [fixed], dry_run: true }, ctx()))).toMatch(/20001 cells; one call changes at most 20000/);
  });
});

describe('set_budget_drivers: live', () => {
  async function dryHash(changes: unknown[]): Promise<string> {
    afterSave();
    return String(json(await setBudgetDriversTool.handler({ ...base, changes, dry_run: true }, ctx())).plan_hash);
  }

  it('always needs the dry run\'s plan_hash; another one is refused; a stale version_token is refused', async () => {
    expect(text(await setBudgetDriversTool.handler({ ...base, changes: [fixed] }, ctx()))).toMatch(/plan_hash is required/);
    expect(text(await setBudgetDriversTool.handler({ ...base, changes: [fixed], plan_hash: 'c'.repeat(64) }, ctx()))).toMatch(/plan changed since your dry run/);
    expect(text(await setBudgetDriversTool.handler({ ...base, changes: [fixed], plan_hash: 'c'.repeat(64), version_token: '2026-11-16T09:00:00.000001Z' }, ctx())))
      .toMatch(/changed since your dry run \(its version_token moved\)/);
    expect(saveDriver).not.toHaveBeenCalled();
  });

  it('the hash binds the stored drivers: a driver line changed since the dry run is a changed plan', async () => {
    const hash = await dryHash([fixed]);
    vi.clearAllMocks();
    vi.mocked(getVersion).mockResolvedValue(version() as never);
    vi.mocked(loadGridReadModel).mockResolvedValue(model());
    vi.mocked(loadGridCells).mockResolvedValue({ versionId: VERSION, updatedAt: TOKEN, cells: BEFORE } as never);
    vi.mocked(listDriverLines).mockResolvedValue([stored({ glAccountId: SALES })] as never);
    expect(text(await setBudgetDriversTool.handler({ ...base, changes: [fixed], plan_hash: hash }, ctx()))).toMatch(/plan changed/);
    expect(saveDriver).not.toHaveBeenCalled();
  });

  it('applies the changes in order with the token chained, records a set_budget_drivers snapshot of every changed cell', async () => {
    const changes = [fixed, { op: 'add_hire', label: 'Sales rep', start_month: '2026-04', fte: 1.5, cost_centre: 'C1' }];
    const hash = await dryHash(changes);
    vi.mocked(saveDriver).mockClear();
    vi.mocked(createHire).mockClear();
    afterSave();
    const r = await setBudgetDriversTool.handler({ ...base, changes, plan_hash: hash }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.wroteNothing).toBeUndefined();
    expect(vi.mocked(createHire).mock.calls[0]![2]).toEqual({ versionId: VERSION, expectedUpdatedAt: T2 });
    expect(vi.mocked(createHire).mock.calls[0]![3]).toEqual({ label: 'Sales rep', costCentreId: CC1, startMonth: '2026-04', endMonth: null, fte: 1.5 });
    const snap = vi.mocked(recordSnapshot).mock.calls[0]![1];
    expect(snap).toMatchObject({ versionId: VERSION, tool: 'set_budget_drivers', tokenBefore: TOKEN, tokenAfter: '2026-11-16T10:00:06.000001Z' });
    expect(snap.cells).toHaveLength(3);
    expect(snap.cells[0]).toEqual({ a: RENT, c1: null, c2: null, b: null, m: '2026-03', before: '100.00', after: '250.00', bs: 'manual', as: 'driver' });
    expect(json(r)).toMatchObject({ snapshot_id: 'snap-1', version_token: '2026-11-16T10:00:06.000001Z', restorable: false });
  });

  it('a refusal after an earlier change wrote throws (the registry rolls the whole call back), naming the change', async () => {
    const changes = [fixed, { op: 'refresh_headcount' }];
    vi.mocked(refreshHeadcount).mockResolvedValueOnce(outcome() as never);
    const hash = await dryHash(changes);
    afterSave();
    vi.mocked(refreshHeadcount).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked'));
    await expect(setBudgetDriversTool.handler({ ...base, changes, plan_hash: hash }, ctx())).rejects.toThrow(/Change 1 \(refresh_headcount\) was refused: This budget version is locked/);
  });

  it('delete_driver resolves the row\'s driver id and calls the delete service', async () => {
    vi.mocked(listDriverLines).mockResolvedValue([stored()] as never);
    vi.mocked(deleteDriver).mockResolvedValue(outcome({ deleted: true, id: 'd-1' }) as never);
    afterSave();
    await setBudgetDriversTool.handler({ ...base, changes: [{ op: 'delete_driver', account: '6000' }], dry_run: true }, ctx());
    expect(vi.mocked(deleteDriver).mock.calls[0]![3]).toBe('d-1');
  });
});

describe('get_budget_drivers: per-head detail for budget writers only (#979)', () => {
  const perHead = stored({ kind: 'per_head', amount: 41666.67, headcountCostCentreId: CC1 });
  beforeEach(() => {
    vi.mocked(listDrivers).mockImplementation(async (_c, _v, access) => ({ drivers: visibleDriverLines([perHead] as never, access) }));
    vi.mocked(listHires).mockResolvedValue({ hires: [{ id: 'h-1', label: 'Sales rep', costCentreId: CC1, startMonth: '2026-04', endMonth: null, fte: 1, updatedAt: TOKEN }] });
    vi.mocked(readHeadcount).mockImplementation(async (_c, _v, scope, access) => (access === 'full'
      ? { costCentreId: scope, months: [{ month: '2026-03', payroll: 1, hires: 0, total: 1 }], asOf: TOKEN }
      : { costCentreId: scope, perHeadRestricted: true }) as never);
  });

  it('a viewer gets the line without its rate and no headcount counts', async () => {
    const out = json(await getBudgetDriversTool.handler({ version_id: VERSION }, ctx('viewer', ['read:reports'])));
    expect(vi.mocked(listDrivers).mock.calls[0]![2]).toBe('totals');
    expect(out.drivers).toEqual([expect.objectContaining({ kind: 'per_head', per_head_restricted: true })]);
    expect(JSON.stringify(out.drivers)).not.toMatch(/41666/);
    expect(out.headcount).toMatchObject({ per_head_restricted: true });
    expect(JSON.stringify(out.headcount)).not.toMatch(/payroll/);
  });

  it('a manager gets the rate (decimal text), the headcount by month, hires and overrides', async () => {
    vi.mocked(loadGridReadModel).mockResolvedValue(model({ cells: [cell('2026-04', 75, 'override')] }));
    const out = json(await getBudgetDriversTool.handler({ version_id: VERSION, headcount_cost_centre: 'C1' }, ctx('manager', ['read:reports'])));
    expect(out.drivers).toEqual([expect.objectContaining({ kind: 'per_head', amount: '41666.67', headcount_cost_centre: 'C1', account: '6000' })]);
    expect(out.headcount).toMatchObject({ cost_centre: 'C1', months: [{ month: '2026-03', payroll: 1, hires: 0, total: 1 }] });
    expect(out.planned_hires).toEqual([expect.objectContaining({ label: 'Sales rep', cost_centre: 'C1', fte: 1 })]);
    expect(out.overrides).toEqual([{ account: '6000', level: 'company', member: null, month: '2026-04', amount: '75.00' }]);
    expect(vi.mocked(readHeadcount).mock.calls[0]![2]).toBe(CC1);
  });

  it("another company's version is the shared Not found", async () => {
    vi.mocked(getVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    expect(text(await getBudgetDriversTool.handler({ version_id: VERSION }, ctx()))).toBe('Not found');
    expect(listDrivers).not.toHaveBeenCalled();
  });
});
