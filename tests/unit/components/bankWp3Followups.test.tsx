/**
 * WP3 follow-ups (from the #1508 breaker's round 4), the REAL action handlers and busy hook with only the network mocked:
 *  - activity restarts the silence timer of the operation it concerns only (a hung Delete is not kept alive by other actions);
 *  - a newest edit refused while an older one is still in flight waits for that answer (the server may hold the older value);
 *  - a refused first-ever cost-centre edit on a line with no selection removes the empty entry;
 *  - a busy object without `touch` does not break an action.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), undoable: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { trackedEditCount } from '@/components/accounting/bank-transactions/bankTxEditTracker';
import { useBankTxBusy, type BankTxBusy } from '@/components/accounting/bank-transactions/useBankTxBusy';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

const json = (data: unknown = {}) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { message: 'refused' } }), { status: 400 });
const tx = (id: string, extra: Partial<BankTx> = {}) => ({ id, description: id, amount: -5, transactionDate: '2026-01-01', status: 'imported', feedState: 'posted', ...extra }) as BankTx;
const sel = (entityId = 'gl1'): RowSelection => ({ type: 'account', entityId, label: 'Telephone', vatCode: 'none' });
/** What an edit puts on screen (the optimistic row): the rollback only undoes exactly this. */
const shown = (entityId: string, label: string): RowSelection => ({ type: 'account', entityId, label, vatCode: 'none' });

/** The page's REAL busy hook (rendered, not re-implemented), with the progress it is told about recorded. */
function busyGuard() {
  const progress: Array<unknown> = [];
  const hook = renderHook(() => useBankTxBusy());
  const busy: BankTxBusy = {
    get busy() { return hook.result.current.busy; },
    isBusy: (k) => hook.result.current.isBusy(k),
    isRunning: (k) => hook.result.current.isRunning(k),
    touch: (a) => hook.result.current.touch(a),
    get progress() { return hook.result.current.progress; },
    setProgress: (p) => { progress.push(p); },
    run: (key, fn, rows) => hook.result.current.run(key, fn, rows),
  };
  return { busy, progress, hook };
}

function setup(over: Record<string, unknown> = {}) {
  const g = busyGuard();
  const deps = {
    transactions: [tx('t1'), tx('t2'), tx('t3')], glAccounts: [], bankAccounts: [], selectedBank: 'b1',
    selectedIds: new Set(['t1', 't2', 't3']), rowSelections: { t1: sel(), t2: sel(), t3: sel() }, batchType: 'account' as const,
    excludingTxId: null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(),
    setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(), loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(), reloadCurrentView: vi.fn(),
    busy: g.busy, ...over,
  };
  return { deps, progress: g.progress, hook: g.hook, actions: buildBankTxActions(deps as unknown as Parameters<typeof buildBankTxActions>[0]) };
}
const bodies = () => vi.mocked(apiFetch).mock.calls.map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>; } catch { return {}; } });
const sentActions = (action: string) => bodies().filter((b) => b.action === action);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  vi.stubGlobal('confirm', () => true);
});

const mkWith = (busy: BankTxBusy, over: Record<string, unknown>) => buildBankTxActions({
  transactions: [tx('t1'), tx('t2'), tx('t3'), tx('t4')], glAccounts: [], bankAccounts: [], selectedBank: 'b1', selectedIds: new Set(['t1','t2','t3','t4']),
  rowSelections: { t1: sel(), t2: sel(), t3: sel(), t4: sel() }, batchType: 'account', excludingTxId: null, createEntityTxId: null,
  setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(),
  setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(), loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(), reloadCurrentView: vi.fn(),
  busy, ...over,
} as unknown as Parameters<typeof buildBankTxActions>[0]);
const A: RowSelection = { type: 'account', entityId: 'glA', label: 'A', vatCode: 'none' };
function rig(init: Record<string, RowSelection>) {
  let state = init;
  const setRowSelections = (fn: (p: Record<string, RowSelection>) => Record<string, RowSelection>) => { state = fn(state); };
  const gates: Array<{ ok: () => void; no: () => void }> = [];
  vi.mocked(apiFetch).mockImplementation(async () => new Promise<Response>(r => { gates.push({ ok: () => r(json({ saved: true })), no: () => r(refuse()) }); }));
  const build = () => setup({ rowSelections: state, setRowSelections, transactions: [tx('t1')], selectedIds: new Set() }).actions;
  return { get: () => state, set: (s: Record<string, RowSelection>) => { state = s; }, gates, build };
}
const tick = () => new Promise(r => setTimeout(r, 10));


describe('touch() is per operation', () => {
  it('a healthy 4 x 25 s batch keeps its hold (its own requests are its activity); a second click at 61 s is refused; no warning', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useBankTxBusy());
    const allocs: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      allocs.push(JSON.parse(String((init as RequestInit).body)).bankTransactionId);
      await new Promise(r => setTimeout(r, 25_000));
      return json({ journalEntryId: 'je' });
    });
    act(() => { void mkWith(hook.result.current, {}).handleBatchAccept(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(hook.result.current.busy.has('batch-allocate')).toBe(true);
    act(() => { void mkWith(hook.result.current, {}).handleBatchAccept(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(400_000); });
    vi.useRealTimers();
    expect(allocs.filter(a => a === 't1')).toHaveLength(1); // not re-sent
    expect(toast.warning).not.toHaveBeenCalledWith('This is taking too long', expect.anything());
  });

  it('a hung Delete is NOT kept alive by the user unmatching other lines every 40 s', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useBankTxBusy());
    vi.stubGlobal('confirm', () => true);
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      const b = JSON.parse(String((init as RequestInit).body));
      return b.action === 'delete' ? new Promise<Response>(() => undefined) : json({ ok: 1 });
    });
    act(() => { void mkWith(hook.result.current, { selectedIds: new Set(['t1']) }).handleBatchDelete(); });
    for (let i = 0; i < 5; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      await act(async () => { await mkWith(hook.result.current, {}).handleUnmatch(`t${2 + (i % 3)}`); });
    }
    vi.useRealTimers();
    expect(hook.result.current.busy.has('delete')).toBe(false);
    expect(toast.warning).toHaveBeenCalledWith('This is taking too long', expect.any(String));
  });

  it('the hook: touching a key or a row re-arms only the operations it names; touching nothing re-arms nothing', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBankTxBusy());
    act(() => {
      void result.current.run('a', () => new Promise<void>(() => undefined), ['r1']);
      void result.current.run('b', () => new Promise<void>(() => undefined), ['r2']);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    act(() => { result.current.touch({ rows: ['r1'] }); result.current.touch(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); // 70 s: b silent since 0, a since 40
    expect(result.current.busy.has('a')).toBe(true);
    expect(result.current.busy.has('b')).toBe(false);
    vi.useRealTimers();
  });
});

describe('the newest edit refused while an older one is in flight', () => {
  it('Y refused BEFORE X answers, then X is stored: the row shows X (the server holds X)', async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no(); await tick();
    expect(r.get().t1?.entityId).toBe('glY'); // not rolled back past an edit still in flight
    r.gates[0]!.ok(); await tick();
    expect(r.get().t1?.entityId).toBe('glX');
  });
  it('Y refused first, then X refused too: back to the original', async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no(); await tick(); r.gates[0]!.no(); await tick();
    expect(r.get().t1?.entityId).toBe('glA');
  });
  it('X refused first, then Y refused: back to the original (the earlier behaviour holds)', async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[0]!.no(); await tick(); r.gates[1]!.no(); await tick();
    expect(r.get().t1?.entityId).toBe('glA');
  });
  it('Y refused first, X stored, and the user has since moved on to Z: Z stays', async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no(); await tick();
    r.build().handleRowEntityChange('t1', 'glZ', 'Z'); // a newer edit
    r.gates[0]!.ok(); await tick();
    expect(r.get().t1?.entityId).toBe('glZ');
    r.gates[2]!.ok(); await tick();
    expect(r.get().t1?.entityId).toBe('glZ');
  });
  it('an entity edit refused while a cost-centre edit is stored keeps the cost centre (groups stay independent)', async () => {
    const r = rig({ t1: { ...A, cc1Id: 'c0' } });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowDimensionChange('t1', 'c1', '', '');
    r.gates[0]!.no(); await tick(); r.gates[1]!.ok(); await tick();
    expect(r.get().t1).toMatchObject({ entityId: 'glA', cc1Id: 'c1' });
  });
  it('nothing is left tracked once every answer is in', async () => {
    const before = trackedEditCount();
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no(); await tick(); r.gates[0]!.ok(); await tick();
    expect(trackedEditCount()).toBe(before);
  });
});

describe('a refused first-ever cost-centre edit on a line with no selection', () => {
  it('removes the empty entry instead of leaving a blank allocation behind', async () => {
    const r = rig({});
    r.build().handleRowDimensionChange('t1', 'c1', '', '');
    expect(r.get().t1?.cc1Id).toBe('c1'); // optimistic
    r.gates[0]!.no(); await tick();
    expect(r.get().t1).toBeUndefined();
  });
  it('but keeps the entry when an allocation was chosen on it meanwhile', async () => {
    const r = rig({});
    r.build().handleRowDimensionChange('t1', 'c1', '', '');
    r.set({ t1: { ...A, cc1Id: 'c1' } }); // the user picked an account in the meantime
    r.gates[0]!.no(); await tick();
    expect(r.get().t1).toMatchObject({ entityId: 'glA' });
    expect(r.get().t1?.cc1Id).toBeUndefined();
  });
});

describe('a busy object without touch', () => {
  it('does not break an action (touch is optional-called)', async () => {
    const g = busyGuard();
    const { touch: _t, ...noTouch } = g.busy as unknown as Record<string, unknown>;
    void _t;
    vi.mocked(apiFetch).mockImplementation(async () => json({ accepted: 1 }));
    const a = mkWith({ ...(noTouch as object), get busy() { return g.busy.busy; }, run: g.busy.run, isRunning: g.busy.isRunning, isBusy: g.busy.isBusy, setProgress: g.busy.setProgress, progress: null } as unknown as BankTxBusy, {});
    await expect(a.handleBulkAccept()).resolves.toBeUndefined();
    expect(sentActions('bulk_accept')).toHaveLength(1);
  });
});
