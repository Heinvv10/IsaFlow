/**
 * PR 3 (driver tools): what restore_budget_version covers. It undoes AMOUNT writes only (set_budget_amounts,
 * set_budget_annual). A set_budget_drivers snapshot is refused (restore cannot put driver lines, planned hires
 * and overrides back exactly), and an amount write is refused once the version's drivers changed after it
 * (any driver write audits `driverAction`; one in the write's own request counts too, conservatively).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', async (orig) => ({ ...(await orig<object>()), latestSnapshot: vi.fn(), markRestored: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionActivity', () => ({ driverChangesSince: vi.fn(async () => 0) }));
vi.mock('@/modules/accounting/services/budgets/gridSave', () => ({ saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverRepository', () => ({ listDriverLines: vi.fn(async () => []) }));

import { latestSnapshot, DRIVER_WRITE_TOOL, type SnapshotCell } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { driverChangesSince } from '@/modules/accounting/services/budgets/budgetVersionActivity';
import { planRestore } from '@/modules/accounting/services/budgets/budgetSnapshotRestore';

const A = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const T = '2026-11-16T10:00:00.000001Z';
const cell: SnapshotCell = { a: A, c1: null, c2: null, b: null, m: '2026-03', before: '10.00', after: '20.00', bs: 'manual', as: 'manual' };
const current = { token: T, cells: new Map([[`${A}||||2026-03`, { cents: 2000, source: 'manual' }]]), statusMovedAt: null };
const owner = { userId: 'someone', role: 'owner' };
const snap = (over: Record<string, unknown> = {}) => ({ id: 's1', tool: 'set_budget_amounts', tokenAfter: T, createdAt: T, createdBy: 'author', restored: false, cells: [cell], ...over });

beforeEach(() => { vi.clearAllMocks(); vi.mocked(latestSnapshot).mockResolvedValue(snap()); vi.mocked(driverChangesSince).mockResolvedValue(0); });

describe('restore covers amount writes only', () => {
  it('the driver tool name is the one the snapshots record', () => {
    expect(DRIVER_WRITE_TOOL).toBe('set_budget_drivers');
  });

  it('refuses the snapshot of a set_budget_drivers write, saying what restore covers and what to do', async () => {
    vi.mocked(latestSnapshot).mockResolvedValue(snap({ tool: 'set_budget_drivers' }));
    const p = await planRestore('co', V, null, current, owner);
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/was set_budget_drivers.*undoes amount writes only.*set_budget_drivers/) });
  });

  it('refuses an amount write once the drivers changed after it (counted from the write\'s own transaction time)', async () => {
    vi.mocked(driverChangesSince).mockResolvedValue(2);
    const p = await planRestore('co', V, null, current, owner);
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/drivers of this version changed since that write/i) });
    expect(driverChangesSince).toHaveBeenCalledWith('co', V, T);
  });

  it('an amount write whose drivers did not change since still restores', async () => {
    expect((await planRestore('co', V, null, current, owner)).ok).toBe(true);
  });
});
