/**
 * The versions bar's `run` (spec §10) over the real grid hook: a transition sends the version's
 * token, then reloads the version (new token) and the list; a STALE refusal reloads and says the
 * latest is on screen; a dirty grid is refused before any request; a delete opens the year's
 * default version. Fetch mocked at the edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useBudgetGrid } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import { useWorkspaceVersions } from '@/components/accounting/budgets/workspace/useWorkspaceVersions';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { fail, installNetwork, isModel, ok } from './workspaceHarness';
import { ID, MONTHS, TOKEN, gridModel } from './gridFixture';

let net: ReturnType<typeof installNetwork>;
beforeEach(() => { net = installNetwork(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const T2 = '2026-10-26T18:09:00.000001Z';
const statusUrl = `/api/accounting/budget-versions/${ID.version}/status`;
const lists = () => net.sent.filter((s) => s.url.startsWith('/api/accounting/budget-versions?')).length;
const reads = () => net.sent.filter((s) => isModel(s.url));

async function setup() {
  const hook = renderHook(() => {
    const grid = useBudgetGrid({ fiscalYear: 2027, canWrite: true });
    return { grid, versions: useWorkspaceVersions(2027, grid) };
  });
  await waitFor(() => expect(hook.result.current.grid.status).toBe('ready'));
  await waitFor(() => expect(hook.result.current.versions.versions).toHaveLength(1));
  return hook;
}

describe('useWorkspaceVersions.run', () => {
  it('approve sends the token, then reloads the version (new token) and the list', async () => {
    const { result } = await setup();
    const listsBefore = lists();
    net.on((u, m) => m === 'POST' && u === statusUrl, () => ok({ ...gridModel().version!, status: 'approved', updatedAt: T2 }));
    net.on(isModel, () => ok({ ...gridModel(), updatedAt: T2, version: { ...gridModel().version!, status: 'approved', updatedAt: T2 } }));
    let out: string | null = 'unset';
    await act(async () => { out = await result.current.versions.run({ action: 'approve' }); });
    expect(out).toBeNull();
    expect(net.sent.find((s) => s.url === statusUrl)!.body).toEqual({ action: 'approve', expectedUpdatedAt: TOKEN });
    expect(reads().pop()!.url).toBe(`/api/accounting/budget-grid?version_id=${ID.version}`);
    await waitFor(() => expect(result.current.grid.token).toBe(T2));
    await waitFor(() => expect(lists()).toBeGreaterThan(listsBefore));
  });

  it('a STALE refusal reloads what is there now and says so', async () => {
    const { result } = await setup();
    net.on((u, m) => m === 'POST' && u === statusUrl, () => fail(409, 'This budget changed since you opened it', { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: T2, status: 'draft' }));
    net.on(isModel, () => ok({ ...gridModel(), updatedAt: T2, version: { ...gridModel().version!, updatedAt: T2 } }));
    const readsBefore = reads().length;
    let out: string | null = null;
    await act(async () => { out = await result.current.versions.run({ action: 'lock' }); });
    expect(out).toBe('This budget changed since you opened it The latest version is now on screen; check it and try again.');
    expect(reads().length).toBe(readsBefore + 1);
    await waitFor(() => expect(result.current.grid.token).toBe(T2));
  });

  it('a dirty grid is refused before any request', async () => {
    const { result } = await setup();
    act(() => { result.current.grid.store.apply([{ key: cellKey({ glAccountId: ID.rev2, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0]! }), cents: 1 }]); });
    await waitFor(() => expect(result.current.grid.dirtyCount).toBe(1));
    const sentBefore = net.sent.length;
    let out: string | null = null;
    await act(async () => { out = await result.current.versions.run({ action: 'approve' }); });
    expect(out).toMatch(/Save or discard 1 unsaved change/);
    expect(net.sent.length).toBe(sentBefore);
  });

  it('a delete opens the year\'s default version', async () => {
    const { result } = await setup();
    net.on((u, m) => m === 'DELETE' && u === `/api/accounting/budget-versions/${ID.version}`, () => ok({ deleted: true }));
    await act(async () => { expect(await result.current.versions.run({ action: 'delete' })).toBeNull(); });
    expect(reads().pop()!.url).toBe('/api/accounting/budget-grid?fiscal_year=2027');
  });
});
