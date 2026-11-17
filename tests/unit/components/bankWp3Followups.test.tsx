/**
 * WP3 follow-ups (from the #1508 breaker's round 4), the REAL action handlers and busy hook with only the network mocked:
 *  - activity restarts the silence timer of the operation it concerns only (a hung Delete is not kept alive by other actions);
 *  - a newest edit refused while an older one is still in flight waits for that answer (the server may hold the older value);
 *  - a refused first-ever cost-centre edit on a line with no selection removes the empty entry;
 *  - a busy object without `touch` does not break an action.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), undoable: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { trackedEditCount, resetEditTracker, EDIT_ABANDON_MS } from '@/components/accounting/bank-transactions/bankTxEditTracker';
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

afterEach(() => { cleanup(); vi.useRealTimers(); resetEditTracker(); }); // a failing fake-timer test must not leave fake timers on for the next one
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
  let refused = 0;
  return {
    get: () => state, set: (s: Record<string, RowSelection>) => { state = s; }, gates, build,
    /** Refuse save i and wait for the app to report it (the error toast is the observable). */
    no: async (i: number) => { gates[i]!.no(); refused += 1; await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(refused)); await settleIO(); },
    /** Store save i; a stored save has no observable of its own, so let the event loop turn. */
    ok: async (i: number) => { gates[i]!.ok(); await settleIO(); },
  };
}
/** Turns of the event loop (no wall clock, so load cannot change the outcome): lets the app consume a mocked response that has no observable effect of its own. */
const settleIO = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(r => setImmediate(r)); };


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
    await r.no(1);
    expect(r.get().t1?.entityId).toBe('glY'); // not rolled back past an edit still in flight
    await r.ok(0);
    expect(r.get().t1?.entityId).toBe('glX');
  });
  it('Y refused first, then X refused too: back to the original', async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    await r.no(1); await r.no(0);
    expect(r.get().t1?.entityId).toBe('glA');
  });
  it('X refused first, then Y refused: back to the original (the earlier behaviour holds)', async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    await r.no(0); await r.no(1);
    expect(r.get().t1?.entityId).toBe('glA');
  });
  it('Y refused first, X stored, and the user has since moved on to Z: Z stays', async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    await r.no(1);
    r.build().handleRowEntityChange('t1', 'glZ', 'Z'); // a newer edit
    await r.ok(0);
    expect(r.get().t1?.entityId).toBe('glZ');
    await r.ok(2);
    expect(r.get().t1?.entityId).toBe('glZ');
  });
  it('an entity edit refused while a cost-centre edit is stored keeps the cost centre (groups stay independent)', async () => {
    const r = rig({ t1: { ...A, cc1Id: 'c0' } });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowDimensionChange('t1', 'c1', '', '');
    await r.no(0); await r.ok(1);
    expect(r.get().t1).toMatchObject({ entityId: 'glA', cc1Id: 'c1' });
  });
  it('nothing is left tracked once every answer is in', async () => {
    const before = trackedEditCount();
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    await r.no(1); await r.ok(0);
    expect(trackedEditCount()).toBe(before);
  });
});

describe('a refused first-ever cost-centre edit on a line with no selection', () => {
  it('removes the empty entry instead of leaving a blank allocation behind', async () => {
    const r = rig({});
    r.build().handleRowDimensionChange('t1', 'c1', '', '');
    expect(r.get().t1?.cc1Id).toBe('c1'); // optimistic
    await r.no(0);
    expect(r.get().t1).toBeUndefined();
  });
  it('but keeps the entry when an allocation was chosen on it meanwhile', async () => {
    const r = rig({});
    r.build().handleRowDimensionChange('t1', 'c1', '', '');
    r.set({ t1: { ...A, cc1Id: 'c1' } }); // the user picked an account in the meantime
    await r.no(0);
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

describe('an older save that never answers cannot pin the row to a refused value', () => {
  it('Y is refused while X hangs: Y stays shown at first, then after the abandon time the row goes back to the last STORED value, with a warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no();
    await vi.advanceTimersByTimeAsync(5); await settleIO();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(r.get().t1?.entityId).toBe('glY'); // deferred behind the in-flight X
    await vi.advanceTimersByTimeAsync(EDIT_ABANDON_MS - 100);
    expect(r.get().t1?.entityId).toBe('glY'); // not yet
    await vi.advanceTimersByTimeAsync(200); await settleIO();
    expect(r.get().t1?.entityId).toBe('glA'); // X's answer is unknown: back to what is known to be stored
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('not been confirmed'), expect.any(String));
    r.gates[0]!.ok(); // the hung request finally answers: nothing more happens to the row
    await vi.advanceTimersByTimeAsync(5); await settleIO();
    expect(r.get().t1?.entityId).toBe('glA');
    expect(trackedEditCount()).toBe(0);
  });

  it('an answer that arrives in time cancels the wait: no warning, no put-back to the old value', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no(); await vi.advanceTimersByTimeAsync(5); await settleIO();
    r.gates[0]!.ok(); await vi.advanceTimersByTimeAsync(5); await settleIO();
    expect(r.get().t1?.entityId).toBe('glX');
    expect(vi.getTimerCount()).toBe(0); // the wait was cancelled, not left to fire
    await vi.advanceTimersByTimeAsync(EDIT_ABANDON_MS * 2); await settleIO();
    expect(r.get().t1?.entityId).toBe('glX');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('Apply Rules keeps its hold while it makes progress', () => {
  it('rules (55 s) then smart-categorize (14 s): 69 s in all, never silent for 60 s, so the hold lasts and nothing warns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hook = renderHook(() => useBankTxBusy());
    vi.mocked(apiFetch).mockImplementation(async (u) => {
      await new Promise(res => setTimeout(res, String(u).includes('smart-categorize') ? 14_000 : 55_000));
      return json({ applied: 2, categorized: 1, skipped: 0 });
    });
    let done!: Promise<unknown>;
    act(() => { done = mkWith(hook.result.current, {}).handleApplyRules() as Promise<unknown>; });
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); await settleIO(); }); // past 60 s in total, 10 s into the second step
    expect(hook.result.current.busy.has('apply-rules')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); await done; await settleIO(); });
    expect(toast.warning).not.toHaveBeenCalledWith('This is taking too long', expect.anything());
    expect(hook.result.current.busy.size).toBe(0);
  });
  it('but one request silent for 60 s inside it still releases', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hook = renderHook(() => useBankTxBusy());
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(() => undefined));
    act(() => { void mkWith(hook.result.current, {}).handleApplyRules(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); await settleIO(); });
    expect(hook.result.current.busy.has('apply-rules')).toBe(false);
  });
});

describe('the abandon wait, edge by edge', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  const adv = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settleIO(); };
  const hungXThenRefusedY = async () => {
    const r = rig({ t1: A });
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no(); await adv(10);
    return r;
  };
  const warned = () => toast.warning.mock.calls.filter(c => String(c[0]).includes('not been confirmed')).length;

  it('after the wait fired, a NEW refused edit Z behind the same hung request arms its own wait and resolves too', async () => {
    const r = await hungXThenRefusedY();
    await adv(EDIT_ABANDON_MS + 1000);
    expect(r.get().t1?.entityId).toBe('glA');
    r.build().handleRowEntityChange('t1', 'glZ', 'Z');
    r.gates[2]!.no(); await adv(10);
    expect(r.get().t1?.entityId).toBe('glZ'); // deferred again
    await adv(EDIT_ABANDON_MS + 1000);
    expect(r.get().t1?.entityId).toBe('glA');
    expect(warned()).toBe(2);
  });

  it('a FRESH in-flight edit W with the very values of the refused Y is not reverted when the wait fires (keyed on the edit, not on equal values)', async () => {
    const r = await hungXThenRefusedY();
    r.build().handleRowEntityChange('t1', 'glY', 'Y'); // W: same values as Y, in flight
    await adv(EDIT_ABANDON_MS + 1000);
    expect(r.get().t1?.entityId).toBe('glY');
    expect(warned()).toBe(0);
    await r.ok(2);
    expect(r.get().t1?.entityId).toBe('glY');
  });

  it('a different fresh edit W during the wait is left alone, with no warning', async () => {
    const r = await hungXThenRefusedY();
    r.build().handleRowEntityChange('t1', 'glW', 'W');
    await adv(EDIT_ABANDON_MS + 1000);
    expect(r.get().t1?.entityId).toBe('glW');
    expect(warned()).toBe(0);
  });

  it('the warning appears only when the put-back changed the row: a list reload that already showed the stored value says nothing', async () => {
    const r = await hungXThenRefusedY();
    r.set({ t1: { ...A } }); // a reload reseeded the row from the server
    await adv(EDIT_ABANDON_MS + 1000);
    expect(r.get().t1?.entityId).toBe('glA');
    expect(warned()).toBe(0);
  });

  it('...and when the put-back lands on the very value the row already shows, nothing changed, so nothing is announced', async () => {
    const Y: RowSelection = { type: 'account', entityId: 'glY', label: 'Y', vatCode: 'none' };
    const r = rig({ t1: Y }); // the server already holds Y
    r.build().handleRowEntityChange('t1', 'glX', 'X'); r.build().handleRowEntityChange('t1', 'glY', 'Y');
    r.gates[1]!.no(); await adv(10);
    await adv(EDIT_ABANDON_MS + 1000);
    expect(r.get().t1?.entityId).toBe('glY');
    expect(warned()).toBe(0);
  });

  it('case O: Y deferred, a FRESH W with Y\'s values is saved, then the older X is saved last: the row stays Y (the deferred put-back is not W\'s)', async () => {
    const r = await hungXThenRefusedY(); // X in flight, Y refused and deferred behind it
    r.build().handleRowEntityChange('t1', 'glY', 'Y'); // W: a fresh edit with Y's very values
    await r.ok(2); // W stored
    expect(r.get().t1?.entityId).toBe('glY');
    await r.ok(0); // the older X answers last: it must not trigger Y's stale put-back over W
    expect(r.get().t1?.entityId).toBe('glY');
    expect(trackedEditCount()).toBe(0);
  });

  it('a late REFUSAL of the hung request after the wait fired changes nothing more and leaves the tracker clean', async () => {
    const r = await hungXThenRefusedY();
    await adv(EDIT_ABANDON_MS + 1000);
    await r.no(0);
    expect(r.get().t1?.entityId).toBe('glA');
    expect(trackedEditCount()).toBe(0);
  });
});

