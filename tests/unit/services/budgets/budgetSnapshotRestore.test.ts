/**
 * planRestore's rules (review round 1): only the version's most recent snapshot, only unrestored, only by its
 * author or an owner / admin, only while the token AND every cell's value and source are what the write left
 * (the content check is what holds inside one transaction, where the token cannot move); the plan restores a
 * cell that was a driver's computed value as a clear, and carries a plan_hash bound to the current cells.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', async (orig) => ({ ...(await orig<object>()), latestSnapshot: vi.fn(), markRestored: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridSave', () => ({ saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridCells: vi.fn() }));

import { latestSnapshot, type SnapshotCell } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { planRestore } from '@/modules/accounting/services/budgets/budgetSnapshotRestore';

const A = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const T = '2026-11-16T10:00:00.000001Z';
const c = (m: string, before: string | null, after: string | null, bs: string | null = 'manual', as: string | null = 'manual'): SnapshotCell =>
  ({ a: A, c1: null, c2: null, b: null, m, before, after, bs: before === null ? null : bs, as: after === null ? null : as });
const snap = (over: Record<string, unknown> = {}) => ({
  id: 's1', tool: 'set_budget_amounts', tokenAfter: T, createdAt: T, createdBy: 'author', restored: false,
  cells: [c('2026-03', '10.00', '20.00'), c('2026-04', null, '5.00'), c('2026-05', '7.00', '9.00', 'driver', 'override')], ...over,
});
const now = (entries: Array<[string, number, string]>) => new Map(entries.map(([m, cents, source]) => [`${A}||||${m}`, { cents, source }]));
const AFTER = now([['2026-03', 2000, 'manual'], ['2026-04', 500, 'manual'], ['2026-05', 900, 'override']]);
const owner = { userId: 'someone', role: 'owner' };

beforeEach(() => { vi.mocked(latestSnapshot).mockResolvedValue(snap()); });

describe('planRestore', () => {
  it('plans the before-values (a driver value as a clear) with a plan_hash', async () => {
    const p = await planRestore('co', V, null, { token: T, cells: AFTER }, { userId: 'author', role: 'manager' });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.cells.map((x) => [x.month, x.amount, x.clear ?? false])).toEqual([['2026-03', 10, false], ['2026-04', null, true], ['2026-05', null, true]]);
    expect(p.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses when the token is the same but a cell differs (one transaction: the token cannot move)', async () => {
    const p = await planRestore('co', V, null, { token: T, cells: now([['2026-03', 2000, 'manual'], ['2026-04', 600, 'manual'], ['2026-05', 900, 'override']]) }, owner);
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/1 of its 3 cells differ now/), differingCount: 1 });
  });

  it('refuses when only the source differs (an override reset to its driver since)', async () => {
    const p = await planRestore('co', V, null, { token: T, cells: now([['2026-03', 2000, 'manual'], ['2026-04', 500, 'manual'], ['2026-05', 900, 'driver']]) }, owner);
    expect(p).toMatchObject({ ok: false, differingCount: 1 });
  });

  it('refuses when the latest snapshot is already restored (restores never chain to an earlier write)', async () => {
    vi.mocked(latestSnapshot).mockResolvedValue(snap({ restored: true }));
    expect(await planRestore('co', V, null, { token: T, cells: AFTER }, owner)).toMatchObject({ ok: false, reason: expect.stringMatching(/already restored; an earlier write cannot be restored/) });
  });

  it('refuses another person who is neither the author nor an owner or admin; admits the author and an admin', async () => {
    expect(await planRestore('co', V, null, { token: T, cells: AFTER }, { userId: 'other', role: 'manager' }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/Only the person whose connection made that write/) });
    expect((await planRestore('co', V, null, { token: T, cells: AFTER }, { userId: 'author', role: 'manager' })).ok).toBe(true);
    expect((await planRestore('co', V, null, { token: T, cells: AFTER }, { userId: 'other', role: 'admin' })).ok).toBe(true);
  });

  it('refuses a snapshot_id that is not the most recent, and a moved token', async () => {
    expect(await planRestore('co', V, 'older', { token: T, cells: AFTER }, owner)).toMatchObject({ ok: false, reason: expect.stringMatching(/Only the most recent MCP write/) });
    expect(await planRestore('co', V, null, { token: '2026-11-16T11:00:00.000001Z', cells: AFTER }, owner)).toMatchObject({ ok: false, reason: expect.stringMatching(/0 of its 3 cells differ now/) });
  });
});
