/**
 * useBudgetGrid round-1 flows: `members` identity (a stable EMPTY in the Company view; member NP
 * that follows every edit in a dimension view, keyed on the store revision), a chained save that
 * fails part-way on a non-409 (the saved parts are marked saved and the error says which parts),
 * a save overtaken by a version switch (never stuck on "saving"), re-apply's result message,
 * and the compare version (never the version itself; cleared on a version switch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useBudgetGrid } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { fail, installNetwork, isModel, isSave, ok } from './workspaceHarness';
import { ID, MONTHS, gridModel } from './gridFixture';

let net: ReturnType<typeof installNetwork>;
beforeEach(() => { net = installNetwork(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const key = (acct: string, m: number, cc1Id: string | null = null) =>
  cellKey({ glAccountId: acct, cc1Id, cc2Id: null, buId: null, month: MONTHS[m]! });
const OTHER = 'b0000000-0000-4000-8000-000000000002';

async function loaded() {
  const hook = renderHook(() => useBudgetGrid({ fiscalYear: 2027, canWrite: true }));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

/** `members` × 12 months of CC1 cells for one account, member ids made up. */
const dimCells = (acct: string, members: number, prefix: string) =>
  Array.from({ length: members * 12 }, (_, i) => ({
    key: key(acct, i % 12, `${prefix}${String(Math.floor(i / 12)).padStart(6, '0')}`), cents: 100,
  }));

describe('members', () => {
  it('Company view: one stable empty array, so a first edit does not change the row handlers', async () => {
    const { result } = await loaded();
    const before = result.current.members;
    act(() => { result.current.store.apply([{ key: key(ID.rev2, 0), cents: 1 }]); });
    await waitFor(() => expect(result.current.dirtyCount).toBe(1));
    expect(result.current.members).toBe(before);
    expect(before).toEqual([]);
  });

  it('a dimension view: member NP follows an edit of an already-dirty cell', async () => {
    const { result } = await loaded();
    act(() => { result.current.setView({ kind: 'cc1', memberId: ID.m1 }); });
    act(() => { result.current.store.apply([{ key: key(ID.dimAcc, 1, ID.m1), cents: 500 }]); });
    const np = () => result.current.members.find(m => m.id === ID.m1)!.total;
    await waitFor(() => expect(np()).toBe(-(1000 + 500)));
    act(() => { result.current.store.apply([{ key: key(ID.dimAcc, 1, ID.m1), cents: 700 }]); }); // dirtyCount stays 1
    await waitFor(() => expect(np()).toBe(-(1000 + 700)));
  });
});

describe('save', () => {
  it('a non-409 refusal mid-chain: the saved part is marked saved, the token moves, the error names the parts', async () => {
    const { result } = await loaded();
    const a = dimCells(ID.opex, 1000, 'c1000000-0000-4000-8000-');
    const b = dimCells(ID.oexp, 800, 'c2000000-0000-4000-8000-');
    act(() => { result.current.store.apply([...a, ...b]); });
    let call = 0;
    net.on((u) => isSave(u), () => (++call === 1
      ? ok({ updatedAt: 'T1', saved: a.length, deleted: 0 })
      : new Response(JSON.stringify({ success: false, error: { message: 'The budget is busy; try again.' } }), { status: 503, headers: { 'Retry-After': '5' } })));
    await act(async () => { await result.current.save(); });
    expect(call).toBe(2);
    expect(result.current.token).toBe('T1');
    expect(result.current.dirtyCount).toBe(b.length);
    expect(result.current.saveState).toEqual({
      status: 'error', retryAfter: 5, failedChunk: 1, chunks: 2,
      message: 'The budget is busy; try again. Part 1 of 2 was saved; the rest was not.',
    });
  });

  it('a save overtaken by a version switch never leaves the save bar on "saving"', async () => {
    const { result } = await loaded();
    let release!: () => void;
    net.on((u) => isSave(u), async () => { await new Promise<void>((r) => { release = r; }); return ok({ updatedAt: 'T2', saved: 1, deleted: 0 }); });
    act(() => { result.current.store.apply([{ key: key(ID.rev2, 0), cents: 1 }]); });
    let saving!: Promise<void>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(result.current.saveState.status).toBe('saving'));
    await act(async () => { await result.current.selectVersion(ID.version); });
    await act(async () => { release(); await saving; });
    expect(result.current.saveState).toEqual({ status: 'idle' });
  });
});

describe('re-apply and compare', () => {
  it('reapplyMine resolves null when done and the message when the fresh read fails', async () => {
    const { result } = await loaded();
    act(() => { result.current.store.apply([{ key: key(ID.rev2, 0), cents: 1 }]); });
    let r: string | null = 'unset';
    await act(async () => { r = await result.current.reapplyMine(); });
    expect(r).toBeNull();
    net.on(isModel, () => fail(500, 'Database unavailable'));
    await act(async () => { r = await result.current.reapplyMine(); });
    expect(r).toBe('Database unavailable');
    expect(result.current.dirtyCount).toBe(1);
  });

  it('never compares a version with itself; a version switch clears the compare', async () => {
    const { result } = await loaded();
    await act(async () => { await result.current.setCompareVersion(ID.version); });
    expect(result.current.compareVersionId).toBeNull();
    expect(net.sent.some((s) => s.url.includes('cells_only'))).toBe(false);
    net.on((u) => u.includes('cells_only'), () => ok({ versionId: OTHER, updatedAt: 'X', cells: [] }));
    await act(async () => { await result.current.setCompareVersion(OTHER); });
    expect(result.current.compareVersionId).toBe(OTHER);
    net.on(isModel, () => ok({ ...gridModel(), version: { ...gridModel().version!, id: OTHER } }));
    await act(async () => { await result.current.selectVersion(OTHER); });
    expect(result.current.compareVersionId).toBeNull();
  });
});
