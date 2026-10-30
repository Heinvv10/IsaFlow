/**
 * useBudgetGrid's in-place re-read (P4, `refresh`): it never cancels a version switch (a switch
 * started while it reads wins; one pending skips it), a failed read answers its message, warnings
 * replace the rows' only when given, and a save in a version with drivers that cannot be re-read
 * says so in the save state.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBudgetGrid } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import { fail, installNetwork, isModel, isSave, ok } from '../workspace/workspaceHarness';
import { ID, T2, driverModel } from './driverFixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const OTHER = 'b0000000-0000-4000-8000-000000000009';
const other = () => { const m = driverModel(); return { ...m, version: { ...m.version!, id: OTHER, name: 'Other' }, updatedAt: T2 }; };

async function loaded() {
  const hook = renderHook(() => useBudgetGrid({ fiscalYear: 2027, canWrite: true }));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

describe('useBudgetGrid refresh', () => {
  it('a version switch started while the re-read is out wins: the re-read is dropped', async () => {
    const net = installNetwork();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let reads = 0;
    net.on(isModel, async (u) => {
      if (u.includes(OTHER)) return ok(other());
      reads++;
      if (reads === 2) await held;
      return ok(driverModel());
    });
    const hook = await loaded();
    let refreshed: Promise<string | null> = Promise.resolve(null);
    act(() => { refreshed = hook.result.current.refresh(); });
    await act(async () => { await hook.result.current.selectVersion(OTHER); });
    expect(hook.result.current.version?.id).toBe(OTHER);
    await act(async () => { release(); await refreshed; });
    expect(hook.result.current.version?.id).toBe(OTHER);
  });

  it('a reload of the same version that finished while the re-read was out wins over the older answer', async () => {
    const net = installNetwork();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let reads = 0;
    const withSales = (amount: number) => {
      const m = driverModel();
      return { ...m, cells: m.cells.map((c) => (c.glAccountId === ID.rev1 ? { ...c, amount } : c)) };
    };
    net.on(isModel, async () => {
      reads++;
      if (reads === 2) { await held; return ok(withSales(1000)); }
      return ok(withSales(reads === 1 ? 1000 : 2000));
    });
    const hook = await loaded();
    let refreshed: Promise<string | null> = Promise.resolve(null);
    act(() => { refreshed = hook.result.current.refresh(); });
    await act(async () => { await hook.result.current.reload(); });
    expect(hook.result.current.store.getRow(`acct:${ID.rev1}`).values[0]).toBe(200_000);
    await act(async () => { release(); await refreshed; });
    expect(hook.result.current.store.getRow(`acct:${ID.rev1}`).values[0]).toBe(200_000);
  });

  it('a re-read while a load is pending is skipped (the load brings the cells)', async () => {
    const net = installNetwork();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    net.on(isModel, async (u) => { if (u.includes(OTHER)) { await held; return ok(other()); } return ok(driverModel()); });
    const hook = await loaded();
    let switching: Promise<void> = Promise.resolve();
    act(() => { switching = hook.result.current.selectVersion(OTHER); });
    const before = net.sent.filter((s) => isModel(s.url)).length;
    await act(async () => { expect(await hook.result.current.refresh()).toBeNull(); });
    expect(net.sent.filter((s) => isModel(s.url)).length).toBe(before);
    await act(async () => { release(); await switching; });
    expect(hook.result.current.version?.id).toBe(OTHER);
  });

  it('a failed re-read answers its message; warnings land only when given', async () => {
    const net = installNetwork();
    let reads = 0;
    net.on(isModel, () => (++reads === 2 ? fail(500, 'Read failed.') : ok(driverModel())));
    const hook = await loaded();
    let message: string | null = null;
    await act(async () => { message = await hook.result.current.refresh(); });
    expect(message).toMatch(/could not be read again: Read failed\./);
    await act(async () => { await hook.result.current.refresh([{ rowKey: `${ID.opex}|||`, message: 'skipped' }]); });
    expect(hook.result.current.store.getRow(`acct:${ID.opex}`).driverWarning).toBe('skipped');
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.store.getRow(`acct:${ID.opex}`).driverWarning).toBe('skipped');
  });

  it('a save in a driver version whose re-read fails says so in the save state', async () => {
    const net = installNetwork();
    let reads = 0;
    net.on(isModel, () => (++reads === 1 ? ok(driverModel()) : fail(500, 'Read failed.')));
    net.on(isSave, () => ok({ updatedAt: T2, saved: 1, deleted: 0, recomputed: 0, reset: 0, driverWarnings: [] }));
    const hook = await loaded();
    const k = `${ID.rev2}||||${driverModel().year.monthKeys[0]}`;
    act(() => { hook.result.current.store.apply([{ key: k, cents: 100 }]); });
    await act(async () => { await hook.result.current.save(); });
    const s = hook.result.current.saveState;
    expect(s.status === 'saved' && s.refreshError).toMatch(/could not be read again/);
  });
});
