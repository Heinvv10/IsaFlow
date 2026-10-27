/**
 * useBudgetGrid (spec §6.4, §7, §11): load by year (stale responses on a year switch dropped),
 * empty and failed states, prior actuals per view, save of a SNAPSHOT (edits made during the save
 * stay dirty), a 409 kept as a stale state with the unsaved edits, "reload and re-apply mine"
 * through PR-A `rebaseDirty`, and typed save errors. Fetch is mocked at the boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBudgetGrid } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import { accountRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { ID, MONTHS, TOKEN, gridModel } from './gridFixture';

type Route = (url: string, body: unknown) => Response | Promise<Response>;
let routes: Array<{ match: (url: string, method: string) => boolean; reply: Route }>;
let sent: Array<{ url: string; method: string; body: unknown }>;

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number, message: string, details?: unknown) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message, details } }), { status });
const on = (match: (url: string, method: string) => boolean, reply: Route) => routes.unshift({ match, reply });
const isModel = (url: string) => url.startsWith('/api/accounting/budget-grid?') && !url.includes('cells_only');
const isSave = (url: string) => url === '/api/accounting/budget-grid/save';
const key = (acct: string, m: number) => cellKey({ glAccountId: acct, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[m]! });

beforeEach(() => {
  routes = [];
  sent = [];
  on(url => url.includes('/prior-actuals'), () => ok({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: MONTHS, cells: [{ glAccountId: ID.rev1, dimensionId: null, month: MONTHS[0], amount: 9 }] }));
  on(isModel, () => ok(gridModel()));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method, body });
    const route = routes.find(r => r.match(url, method));
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    return route.reply(url, body);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function loaded(fiscalYear: number | null = 2027) {
  const hook = renderHook(({ fy }) => useBudgetGrid({ fiscalYear: fy, canWrite: true }), { initialProps: { fy: fiscalYear } });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

describe('useBudgetGrid', () => {
  it('loads the year, fills the store, then the prior actuals for the company view', async () => {
    const { result } = await loaded();
    expect(sent[0]!.url).toBe('/api/accounting/budget-grid?fiscal_year=2027');
    expect(result.current.token).toBe(TOKEN);
    expect(result.current.store.getRow(accountRowKey(ID.rev1)).values[0]).toBe(100000);
    await waitFor(() => expect(result.current.store.getRow(accountRowKey(ID.rev1)).py?.[0]).toBe(900));
    expect(sent.some(s => s.url === '/api/accounting/budget-grid/prior-actuals?fiscal_year=2027&grain=company')).toBe(true);
  });

  it('a year with no version is the empty state; a failed load is the error state with no stale model', async () => {
    on(isModel, () => ok({ ...gridModel(), version: null, updatedAt: null, cells: [] }));
    const empty = renderHook(() => useBudgetGrid({ fiscalYear: 2028, canWrite: true }));
    await waitFor(() => expect(empty.result.current.status).toBe('empty'));
    on(isModel, () => fail(500, 'Database unavailable'));
    const failed = renderHook(() => useBudgetGrid({ fiscalYear: 2028, canWrite: true }));
    await waitFor(() => expect(failed.result.current.status).toBe('error'));
    expect(failed.result.current.error).toBe('Database unavailable');
    expect(failed.result.current.model).toBeNull();
  });

  it('drops a slower response for the year the user already left', async () => {
    let release!: () => void;
    const slow = new Promise<void>(res => { release = res; });
    on(url => url.endsWith('fiscal_year=2027'), async () => { await slow; return ok(gridModel()); });
    const later: GridReadModel = { ...gridModel(), year: { ...gridModel().year, fiscalYear: 2028 } };
    on(url => url.endsWith('fiscal_year=2028'), () => ok(later));
    const hook = renderHook(({ fy }) => useBudgetGrid({ fiscalYear: fy, canWrite: true }), { initialProps: { fy: 2027 } });
    hook.rerender({ fy: 2028 });
    await waitFor(() => expect(hook.result.current.model?.year.fiscalYear).toBe(2028));
    await act(async () => { release(); await slow; });
    expect(hook.result.current.model?.year.fiscalYear).toBe(2028);
  });

  it('saves a snapshot: clears carry clear:true, the token moves on, an edit made during the save stays dirty', async () => {
    const { result } = await loaded();
    const store = result.current.store;
    let release!: () => void;
    on((url) => isSave(url), async () => { await new Promise<void>(res => { release = res; }); return ok({ updatedAt: 'T2', saved: 1, deleted: 1 }); });
    act(() => { store.apply([{ key: key(ID.rev1, 0), cents: null }, { key: key(ID.rev2, 0), cents: 12345 }]); });
    let saving!: Promise<void>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(result.current.saveState.status).toBe('saving'));
    act(() => { store.apply([{ key: key(ID.rev2, 1), cents: 1 }]); });
    await act(async () => { release(); await saving; });
    const body = sent.find(s => isSave(s.url))!.body as { versionId: string; expectedUpdatedAt: string; cells: unknown[] };
    expect(body.versionId).toBe(ID.version);
    expect(body.expectedUpdatedAt).toBe(TOKEN);
    expect(body.cells).toEqual([
      { glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0], amount: null, clear: true },
      { glAccountId: ID.rev2, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0], amount: 123.45 },
    ]);
    expect(result.current.token).toBe('T2');
    expect(result.current.saveState).toEqual({ status: 'saved', saved: 1, deleted: 1 });
    expect(store.getMeta().dirtyCount).toBe(1);
  });

  it('a 409 keeps the edits and exposes the stale state; re-apply rebases them over the fresh version with conflicts', async () => {
    const { result } = await loaded();
    const store = result.current.store;
    on(url => isSave(url), () => fail(409, 'This budget changed since you opened it', { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: 'T9', status: 'draft' }));
    act(() => { store.apply([{ key: key(ID.rev1, 0), cents: 5 }, { key: key(ID.rev2, 0), cents: 6 }]); });
    await act(async () => { await result.current.save(); });
    expect(result.current.stale).toMatchObject({ kind: 'stale', currentUpdatedAt: 'T9', versionStatus: 'draft', failedChunk: 0, chunks: 1, dirtyCount: 2 });
    expect(store.getMeta().dirtyCount).toBe(2);
    // Someone else changed rev1 Mar to R2 000 meanwhile.
    on(isModel, () => ok({ ...gridModel(), updatedAt: 'T9', cells: [...gridModel().cells.filter(c => !(c.glAccountId === ID.rev1 && c.month === MONTHS[0])), { glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0]!, amount: 2000 }] }));
    await act(async () => { await result.current.reapplyMine(); });
    expect(sent.filter(s => isModel(s.url)).pop()!.url).toBe(`/api/accounting/budget-grid?version_id=${ID.version}`);
    expect(result.current.stale).toBeNull();
    expect(result.current.token).toBe('T9');
    expect(store.getRow(accountRowKey(ID.rev1)).values[0]).toBe(5);
    expect(store.getMeta().conflicts).toEqual([key(ID.rev1, 0)]);
    expect(store.getMeta().dirtyCount).toBe(2);
  });

  it('a 429 is a save error with Retry-After; the edits stay', async () => {
    const { result } = await loaded();
    on(url => isSave(url), () => new Response(JSON.stringify({ success: false, error: { message: 'Too many budget saves; wait a minute and try again.' } }), { status: 429, headers: { 'Retry-After': '60' } }));
    act(() => { result.current.store.apply([{ key: key(ID.rev2, 0), cents: 6 }]); });
    await act(async () => { await result.current.save(); });
    expect(result.current.saveState).toEqual({ status: 'error', message: 'Too many budget saves; wait a minute and try again.', retryAfter: 60 });
    expect(result.current.store.getMeta().dirtyCount).toBe(1);
  });

  it('import commit refuses while the grid is dirty and otherwise chains with the preview token, then reloads', async () => {
    const { result } = await loaded();
    const cell = { glAccountId: ID.rev2, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0]!, amount: 1 };
    act(() => { result.current.store.apply([{ key: key(ID.rev2, 0), cents: 6 }]); });
    const refused = await result.current.commitImport([cell], 'P1');
    expect(refused.ok).toBe(false);
    expect(sent.some(s => isSave(s.url))).toBe(false);
    act(() => { result.current.discard(); });
    on(url => isSave(url), () => ok({ updatedAt: 'T3', saved: 1, deleted: 0 }));
    on(isModel, () => ok({ ...gridModel(), updatedAt: 'T3' }));
    await act(async () => { expect((await result.current.commitImport([cell], 'P1')).ok).toBe(true); });
    expect((sent.find(s => isSave(s.url))!.body as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe('P1');
    await waitFor(() => expect(result.current.token).toBe('T3'));
  });
});
