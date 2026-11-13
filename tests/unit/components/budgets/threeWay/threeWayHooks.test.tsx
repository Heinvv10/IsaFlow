/**
 * The three-way hooks run for real (review L10): `useThreeWay` (select clears the old run, M2; answers for a
 * version or year the user left are dropped, L5), `useAssumptionsForm` (a save or derive in flight across a
 * version change never writes into the new form, L6; the row token and the confirm-retry), and `useNavFlags`
 * (a company switch never shows the previous company's flags, M4). Fetches are deferred so they resolve OUT OF ORDER.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { assumptionsView, threeWayView, version, V1, V2 } from './fixtures';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const h = vi.hoisted(() => ({
  fetchThreeWay: vi.fn(), fetchAssumptions: vi.fn(), fetchDerive: vi.fn(), saveAssumptionsDoc: vi.fn(),
  fetchChartOfAccounts: vi.fn(), fetchLoans: vi.fn(), listVersions: vi.fn(),
  company: { id: 'A' } as { id: string } | null, apiFetch: vi.fn(),
}));
vi.mock('@/components/accounting/budgets/threeWay/threeWayClient', () => ({
  fetchThreeWay: h.fetchThreeWay, fetchAssumptions: h.fetchAssumptions, fetchDerive: h.fetchDerive,
  saveAssumptionsDoc: h.saveAssumptionsDoc, fetchChartOfAccounts: h.fetchChartOfAccounts, fetchLoans: h.fetchLoans,
}));
vi.mock('@/components/accounting/budgets/workspace/useWorkspaceVersions', () => ({
  useBudgetYears: () => ({ years: [], initialYear: 2027, error: null, loading: false, retry: () => undefined }),
}));
vi.mock('@/components/accounting/budgets/workspace/budgetWorkspaceClient', () => ({ listVersions: h.listVersions }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: h.company }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: h.apiFetch }));

import { useThreeWay } from '@/components/accounting/budgets/threeWay/useThreeWay';
import { useAssumptionsForm } from '@/components/accounting/budgets/threeWay/useAssumptionsForm';
import { resetNavFlagsCache, useNavFlags } from '@/hooks/useNavFlags';

const runOf = (id: string) => {
  const v = threeWayView();
  v.version = { ...v.version, id };
  return { ok: true, data: v };
};

beforeEach(() => {
  h.fetchChartOfAccounts.mockResolvedValue({ ok: true, data: [] });
  h.fetchLoans.mockResolvedValue({ ok: true, data: [] });
});
afterEach(() => { vi.resetAllMocks(); resetNavFlagsCache(); h.company = { id: 'A' }; });

describe('useThreeWay', () => {
  it('opens the primary, and select() clears the old run at once (no new name over old figures)', async () => {
    h.listVersions.mockResolvedValue({ ok: true, data: [version(), version({ id: V2, name: 'Worst', isPrimary: false })] });
    const second = deferred<unknown>();
    h.fetchThreeWay.mockImplementation((id: string) => (id === V1 ? Promise.resolve(runOf(V1)) : second.promise));
    const { result } = renderHook(() => useThreeWay(null));
    await waitFor(() => expect(result.current.run?.version.id).toBe(V1));
    act(() => result.current.select(V2));
    expect(result.current.run).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { second.resolve(runOf(V2)); });
    expect(result.current.run?.version.id).toBe(V2);
  });

  it('an earlier version answering late is dropped', async () => {
    h.listVersions.mockResolvedValue({ ok: true, data: [version(), version({ id: V2, name: 'Worst', isPrimary: false })] });
    const first = deferred<unknown>();
    h.fetchThreeWay.mockImplementation((id: string) => (id === V1 ? first.promise : Promise.resolve(runOf(V2))));
    const { result } = renderHook(() => useThreeWay(null));
    await waitFor(() => expect(h.fetchThreeWay).toHaveBeenCalledWith(V1));
    act(() => result.current.select(V2));
    await waitFor(() => expect(result.current.run?.version.id).toBe(V2));
    await act(async () => { first.resolve(runOf(V1)); });
    expect(result.current.run?.version.id).toBe(V2);
  });

  it('a year with no versions drops the run still in flight for the old year (L5)', async () => {
    const pending = deferred<unknown>();
    h.listVersions.mockImplementation((y: number) => Promise.resolve({ ok: true, data: y === 2027 ? [version()] : [] }));
    h.fetchThreeWay.mockImplementation(() => pending.promise);
    const { result } = renderHook(() => useThreeWay(null));
    await waitFor(() => expect(h.fetchThreeWay).toHaveBeenCalledWith(V1));
    act(() => result.current.setFiscalYear(2028));
    await waitFor(() => expect(result.current.versionId).toBeNull());
    await act(async () => { pending.resolve(runOf(V1)); });
    expect(result.current.run).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe('useAssumptionsForm', () => {
  const view45 = () => {
    const v = assumptionsView({ updatedAt: 'u2', debtorDays: 45 });
    v.version = { ...v.version, id: V2 };
    return v;
  };

  it('saves with the row token; a save in flight when the version changes never writes into the new form (L6)', async () => {
    const onSaved = vi.fn();
    const save = deferred<unknown>();
    h.fetchAssumptions.mockImplementation((id: string) => Promise.resolve({ ok: true, data: id === V1 ? assumptionsView({ updatedAt: 't1' }) : view45() }));
    h.saveAssumptionsDoc.mockImplementation(() => save.promise);
    const { result, rerender } = renderHook(({ id }) => useAssumptionsForm(id, false, onSaved), { initialProps: { id: V1 } });
    await waitFor(() => expect(result.current.view?.stored?.updatedAt).toBe('t1'));
    act(() => result.current.update((d) => ({ ...d, minimumCash: { value: 1, source: 'manual' } })));
    let saving: Promise<void> = Promise.resolve();
    act(() => { saving = result.current.save(); });
    expect(h.saveAssumptionsDoc.mock.calls[0]![2]).toBe('t1');
    rerender({ id: V2 });
    await waitFor(() => expect(result.current.view?.version.id).toBe(V2));
    await act(async () => { save.resolve({ ok: true, data: { versionId: V1, doc: {}, updatedAt: 't2', updatedBy: 'u' } }); await saving; });
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.view?.stored?.updatedAt).toBe('u2');
    expect(result.current.edited?.workingCapital.debtorDays.value).toBe(45);
    expect(result.current.saving).toBe(false);
  });

  it('a save that throws resolves, shows the error and never leaves the form saving', async () => {
    h.fetchAssumptions.mockResolvedValue({ ok: true, data: assumptionsView({ updatedAt: 't1' }) });
    h.saveAssumptionsDoc.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useAssumptionsForm(V1, false, vi.fn()));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    act(() => result.current.update((d) => ({ ...d, minimumCash: { value: 1, source: 'manual' } })));
    await act(async () => { await expect(result.current.save()).resolves.toBeUndefined(); });
    expect(result.current.saving).toBe(false);
    expect(result.current.saveError).toEqual({ message: 'The assumptions were not saved: boom', issues: [] });
  });

  it('a derive in flight when the version changes never replaces the new form (L6)', async () => {
    const derive = deferred<unknown>();
    h.fetchAssumptions.mockImplementation((id: string) => Promise.resolve(id === V1
      ? { ok: false, kind: 'invalidDoc', message: 'invalid', issues: ['x: y'] }
      : { ok: true, data: view45() }));
    h.fetchDerive.mockImplementation(() => derive.promise);
    const { result, rerender } = renderHook(({ id }) => useAssumptionsForm(id, false, vi.fn()), { initialProps: { id: V1 } });
    await waitFor(() => expect(result.current.invalidDoc).not.toBeNull());
    let deriving: Promise<void> = Promise.resolve();
    act(() => { deriving = result.current.replaceWithDerived(); });
    rerender({ id: V2 });
    await waitFor(() => expect(result.current.view?.version.id).toBe(V2));
    const v = assumptionsView();
    await act(async () => { derive.resolve({ ok: true, data: { version: v.version, assumptions: v.derived.assumptions, evidence: v.derived.evidence } }); await deriving; });
    expect(result.current.replacing).toBe(false);
    expect(result.current.edited?.workingCapital.debtorDays.value).toBe(45);
  });

  it('replacement: no token, then the 409 token only after confirmReplace, once', async () => {
    h.fetchAssumptions.mockResolvedValue({ ok: false, kind: 'invalidDoc', message: 'invalid', issues: [] });
    const v = assumptionsView();
    h.fetchDerive.mockResolvedValue({ ok: true, data: { version: v.version, assumptions: v.derived.assumptions, evidence: v.derived.evidence } });
    h.saveAssumptionsDoc
      .mockResolvedValueOnce({ ok: false, kind: 'stale', message: 's', currentUpdatedAt: 't7' })
      .mockResolvedValueOnce({ ok: true, data: { versionId: V1, doc: {}, updatedAt: 't8', updatedBy: 'u' } });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useAssumptionsForm(V1, false, onSaved));
    await waitFor(() => expect(result.current.invalidDoc).not.toBeNull());
    await act(async () => { await result.current.replaceWithDerived(); });
    await act(async () => { await result.current.save(); });
    expect(h.saveAssumptionsDoc.mock.calls[0]![2]).toBeNull();
    expect(result.current.replaceToken).toBe('t7');
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => { await result.current.confirmReplace(); });
    expect(h.saveAssumptionsDoc.mock.calls[1]![2]).toBe('t7');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('useNavFlags across a company switch (M4)', () => {
  const answer = (enabled: boolean) => new Response(JSON.stringify({ success: true, data: { enabled } }), { status: 200 });
  it("never shows the previous company's flags while the new company's check is in flight", async () => {
    const forB = deferred<Response>();
    h.apiFetch.mockImplementationOnce(() => Promise.resolve(answer(true))).mockImplementationOnce(() => forB.promise);
    const { result, rerender } = renderHook(() => useNavFlags());
    await waitFor(() => expect(result.current.has('budgets_three_way')).toBe(true));
    h.company = { id: 'B' };
    rerender();
    expect(result.current.has('budgets_three_way')).toBe(false);
    await act(async () => { forB.resolve(answer(false)); });
    expect(result.current.has('budgets_three_way')).toBe(false);
  });
});
