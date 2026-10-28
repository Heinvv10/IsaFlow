/**
 * Round 2 M3: "Copy into a new draft version" when the copy is made but cannot be loaded. The
 * hook remembers the copy; trying again re-runs the re-apply into THAT copy and never copies a
 * second time. A failed copy remembers nothing. Fetch mocked at the edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useBudgetGrid } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import { useCopyReapply } from '@/components/accounting/budgets/workspace/useCopyReapply';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { fail, installNetwork, isModel, ok } from './workspaceHarness';
import { ID, MONTHS, gridModel } from './gridFixture';

let net: ReturnType<typeof installNetwork>;
beforeEach(() => { net = installNetwork(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const COPY_ID = 'b0000000-0000-4000-8000-0000000000c1';
const copyVersion = { ...gridModel().version!, id: COPY_ID, name: 'Original (my changes)', kind: 'reforecast' as const, isPrimary: false };
const isCopyPost = (u: string, m: string) => m === 'POST' && u.endsWith(`/budget-versions/${ID.version}/copy`);
const copies = () => net.sent.filter((s) => isCopyPost(s.url, s.method)).length;
const mar = cellKey({ glAccountId: ID.rev2, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0]! });

async function setup() {
  const hook = renderHook(() => {
    const grid = useBudgetGrid({ fiscalYear: 2027, canWrite: true });
    return { grid, copy: useCopyReapply(grid) };
  });
  await waitFor(() => expect(hook.result.current.grid.status).toBe('ready'));
  act(() => { hook.result.current.grid.store.apply([{ key: mar, cents: 2500 }]); });
  return hook;
}

describe('useCopyReapply', () => {
  it('a copy that fails to load is remembered; the retry loads the SAME copy, copying once', async () => {
    const { result } = await setup();
    net.on(isCopyPost, () => ok(copyVersion));
    net.on((u) => isModel(u) && u.includes(COPY_ID), () => fail(503, 'The budget is busy; try again.'));
    let r: Awaited<ReturnType<typeof result.current.copy.copyAndReapply>> | null = null;
    await act(async () => { r = await result.current.copy.copyAndReapply({ name: 'Original (my changes)', kind: 'reforecast' }); });
    expect(r).toEqual({ ok: false, stage: 'load', message: 'The budget is busy; try again.', copyName: 'Original (my changes)' });
    expect(result.current.copy.pendingCopy).toEqual({ id: COPY_ID, name: 'Original (my changes)' });
    expect(result.current.grid.version?.id).toBe(ID.version);
    expect(result.current.grid.dirtyCount).toBe(1);

    net.on((u) => isModel(u) && u.includes(COPY_ID), () => ok({ ...gridModel(), version: copyVersion }));
    await act(async () => { r = await result.current.copy.copyAndReapply({ name: 'ignored on a retry', kind: 'reforecast' }); });
    expect(r).toEqual({ ok: true });
    expect(copies()).toBe(1);
    expect(result.current.copy.pendingCopy).toBeNull();
    expect(result.current.grid.version?.id).toBe(COPY_ID);
    expect(result.current.grid.store.valueAt(mar)).toBe(2500);
    expect(result.current.grid.dirtyCount).toBe(1);
  });

  it('a refused copy remembers nothing: the next try copies again', async () => {
    const { result } = await setup();
    net.on(isCopyPost, () => fail(409, 'A version with that name already exists.', { code: 'BUDGET_VERSION_NAME_TAKEN' }));
    let r: Awaited<ReturnType<typeof result.current.copy.copyAndReapply>> | null = null;
    await act(async () => { r = await result.current.copy.copyAndReapply({ name: 'X', kind: 'reforecast' }); });
    expect(r).toEqual({ ok: false, stage: 'copy', message: 'A version with that name already exists.', copyName: null });
    expect(result.current.copy.pendingCopy).toBeNull();
    net.on(isCopyPost, () => ok(copyVersion));
    net.on((u) => isModel(u) && u.includes(COPY_ID), () => ok({ ...gridModel(), version: copyVersion }));
    await act(async () => { r = await result.current.copy.copyAndReapply({ name: 'Y', kind: 'reforecast' }); });
    expect(r).toEqual({ ok: true });
    expect(copies()).toBe(2);
  });

  it('a year switch forgets a pending copy', async () => {
    const hook = renderHook(({ fy }) => {
      const grid = useBudgetGrid({ fiscalYear: fy, canWrite: true });
      return { grid, copy: useCopyReapply(grid) };
    }, { initialProps: { fy: 2027 } });
    await waitFor(() => expect(hook.result.current.grid.status).toBe('ready'));
    act(() => { hook.result.current.grid.store.apply([{ key: mar, cents: 2500 }]); });
    net.on(isCopyPost, () => ok(copyVersion));
    net.on((u) => isModel(u) && u.includes(COPY_ID), () => fail(503, 'Busy'));
    await act(async () => { await hook.result.current.copy.copyAndReapply({ name: 'Z', kind: 'reforecast' }); });
    expect(hook.result.current.copy.pendingCopy).not.toBeNull();
    hook.rerender({ fy: 2028 });
    await waitFor(() => expect(hook.result.current.copy.pendingCopy).toBeNull());
  });
});
