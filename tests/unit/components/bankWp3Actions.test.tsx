/**
 * WP3 (UI safety), the REAL action handlers with only the network mocked: bulk actions act on rows ON SCREEN only,
 * Delete reports the server's {deleted}, every mutating button refuses a second click while it runs, Batch Allocate shows
 * progress, Unmatch on a reviewed row asks first, Batch Edit persists, and a refused save puts the row back.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), undoable: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { selectedOnScreen, pruneSelection } from '@/components/accounting/bank-transactions/bankTxSelectionView';
import { trackedEditCount, resetEditTracker } from '@/components/accounting/bank-transactions/bankTxEditTracker';
import { useBankTxBusy, type BankTxBusy } from '@/components/accounting/bank-transactions/useBankTxBusy';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

const json = (data: unknown = {}) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { message: 'refused' } }), { status: 400 });
const tx = (id: string, extra: Partial<BankTx> = {}) => ({ id, description: id, amount: -5, transactionDate: '2026-01-01', status: 'imported', feedState: 'posted', ...extra }) as BankTx;
const sel = (entityId = 'gl1'): RowSelection => ({ type: 'account', entityId, label: 'Telephone', vatCode: 'none' });
/** What an edit puts on screen (the optimistic row): the rollback only undoes exactly this. */
const shown = (entityId: string, label: string): RowSelection => ({ type: 'account', entityId, label, vatCode: 'none' });

/** Turns of the event loop (no wall clock, so load cannot change the outcome), for the effect of an answer that has no observable of its own. */
const settleIO = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };
const touchSpy = vi.fn();
/** The page's REAL busy hook (rendered, not re-implemented), with the progress it is told about recorded. */
function busyGuard() {
  const progress: Array<unknown> = [];
  const hook = renderHook(() => useBankTxBusy());
  const busy: BankTxBusy = {
    get busy() { return hook.result.current.busy; },
    isBusy: (k) => hook.result.current.isBusy(k),
    isRunning: (k) => hook.result.current.isRunning(k),
    touch: touchSpy,
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

afterEach(() => { resetEditTracker(); }); // the tracker is module-level: a hung edit of one test must not reach the next
beforeEach(() => {
  vi.mocked(apiFetch).mockReset(); touchSpy.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  vi.stubGlobal('confirm', () => true);
});

describe('the selection against what is on screen', () => {
  it('selectedOnScreen keeps only listed rows; pruneSelection says when nothing needs pruning', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect([...selectedOnScreen(new Set(['a', 'x', 'y']), rows)]).toEqual(['a']);
    expect(pruneSelection(new Set(['a', 'b']), rows)).toBeNull();
    expect([...pruneSelection(new Set(['a', 'x']), rows)!]).toEqual(['a']);
    expect([...selectedOnScreen(new Set(['a']), [])]).toEqual([]);
  });

  it('Delete sends only the selected rows that are on screen (a stale selection from another page is not deleted)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ deleted: 1 }));
    const { actions } = setup({ transactions: [tx('t1')], selectedIds: new Set(['t1', 'gone-1', 'gone-2']) });
    await actions.handleBatchDelete();
    expect(sentActions('delete')).toHaveLength(1);
    expect(sentActions('delete')[0]!.bankTransactionIds).toEqual(['t1']);
  });

  it('Mark as Reviewed and Batch Allocate also act on listed rows only; nothing listed means nothing sent', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ accepted: 1 }));
    const { actions } = setup({ transactions: [tx('t1')], selectedIds: new Set(['t1', 'gone']), rowSelections: { t1: sel(), gone: sel() } });
    await actions.handleBulkAccept();
    expect(sentActions('bulk_accept')[0]!.bankTransactionIds).toEqual(['t1']);
    await actions.handleBatchAccept();
    expect(sentActions('allocate').map((b) => b.bankTransactionId)).toEqual(['t1']);
    vi.mocked(apiFetch).mockClear();
    const none = setup({ transactions: [], selectedIds: new Set(['gone']) });
    await none.actions.handleBulkAccept(); await none.actions.handleBatchDelete();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('Delete reports what the server did', () => {
  const del = async (deleted: unknown) => {
    vi.mocked(apiFetch).mockImplementation(async () => json(deleted === undefined ? {} : { deleted }));
    await setup().actions.handleBatchDelete();
  };
  it('all deleted: a plain success with the SERVER count', async () => {
    await del(3);
    expect(toast.success).toHaveBeenCalledWith('3 transaction(s) deleted');
    expect(toast.warning).not.toHaveBeenCalled();
  });
  it('fewer deleted than asked: a warning naming both numbers and the refused rows', async () => {
    await del(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('1 of 3 transaction(s) deleted', expect.stringContaining('2 were refused'));
  });
  it('none deleted: an error, never a "deleted" success', async () => {
    await del(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Nothing was deleted'));
  });
  it('a reply without a count is not reported as a success of 3', async () => {
    await del(undefined);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('did not say how many'), expect.any(String));
  });
  it('declining the confirm sends nothing', async () => {
    vi.stubGlobal('confirm', () => false);
    await setup().actions.handleBatchDelete();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('in-flight guards', () => {
  /** A fetch that stays open until released, so a second click lands while the first is running. */
  function slow() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async () => { await gate; return json({ deleted: 3, accepted: 3 }); });
    return release;
  }

  it('Delete: a second click while the first runs sends nothing more', async () => {
    const release = slow();
    const { actions } = setup();
    const first = actions.handleBatchDelete();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await actions.handleBatchDelete(); // refused at once
    release(); await first;
    expect(sentActions('delete')).toHaveLength(1);
  });

  it('Mark as Reviewed: the same', async () => {
    const release = slow();
    const { actions } = setup();
    const first = actions.handleBulkAccept();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await actions.handleBulkAccept();
    release(); await first;
    expect(sentActions('bulk_accept')).toHaveLength(1);
  });

  it('Batch Allocate: the same, with progress "i of n" reported and cleared', async () => {
    const release = slow();
    const { actions, progress } = setup();
    const first = actions.handleBatchAccept();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await actions.handleBatchAccept();
    release(); await first;
    expect(sentActions('allocate').length).toBe(3); // one run of 3 lines, not two
    expect(progress[0]).toEqual({ key: 'batch-allocate', done: 0, total: 3 });
    expect(progress.at(-1)).toBeNull();
  });

  it('row Accept by mouse: a double click posts one journal', async () => {
    const release = slow();
    const { actions } = setup();
    const a = actions.handleAccept('t1'), b = actions.handleAccept('t1');
    expect(await b).toBe(false); // the second was refused
    release(); await a;
    expect(sentActions('allocate').filter((x) => x.bankTransactionId === 't1')).toHaveLength(1);
  });

  it('Unmatch and Reverse: one request per line at a time', async () => {
    const release = slow();
    const { actions } = setup();
    const u = actions.handleUnmatch('t1'); void actions.handleUnmatch('t1');
    const r = actions.handleReverse('t2'); void actions.handleReverse('t2');
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    release(); await Promise.all([u, r]);
    expect(sentActions('unmatch')).toHaveLength(1);
    expect(sentActions('reverse')).toHaveLength(1);
  });

  it('a different line is not blocked by the first', async () => {
    const release = slow();
    const { actions } = setup();
    const a = actions.handleUnmatch('t1'), b = actions.handleUnmatch('t2');
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    release(); await Promise.all([a, b]);
    expect(sentActions('unmatch')).toHaveLength(2);
  });

  it('after a run finishes the button works again', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ deleted: 3 }));
    const { actions } = setup();
    await actions.handleBatchDelete(); await actions.handleBatchDelete();
    expect(sentActions('delete')).toHaveLength(2);
  });
});

describe('Unmatch on a reviewed row confirms', () => {
  it('declined: nothing is sent', async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    const { actions } = setup({ transactions: [tx('t1', { reviewedAt: '2026-01-02T00:00:00Z' })] });
    await actions.handleUnmatch('t1');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('accepted: it unmatches', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json());
    const { actions } = setup({ transactions: [tx('t1', { reviewedAt: '2026-01-02T00:00:00Z' })] });
    await actions.handleUnmatch('t1');
    expect(sentActions('unmatch')).toHaveLength(1);
  });
  it('an unreviewed row asks nothing', async () => {
    const confirm = vi.fn(() => true); vi.stubGlobal('confirm', confirm);
    vi.mocked(apiFetch).mockImplementation(async () => json());
    await setup().actions.handleUnmatch('t1');
    expect(confirm).not.toHaveBeenCalled();
    expect(sentActions('unmatch')).toHaveLength(1);
  });
});

describe('Batch Edit persists, and a refused save puts the row back', () => {
  it('Batch Edit saves every selected row to the server, like a single-row edit', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json());
    const { actions } = setup({ rowSelections: {} });
    actions.handleApplyBatchEdit('gl9', 'Fuel');
    await vi.waitFor(() => expect(sentActions('save_selection')).toHaveLength(3));
    expect(sentActions('save_selection').map((b) => b.bankTransactionId).sort()).toEqual(['t1', 't2', 't3']);
    expect(sentActions('save_selection').every((b) => b.selectionEntityId === 'gl9' && b.selectionType === 'account')).toBe(true);
  });

  it('a Batch Edit the server refuses restores each row to what it was', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
    actions.handleApplyBatchEdit('gl9', 'Fuel');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledTimes(1); // ONE report for the batch, not a toast per refused row
    expect(toast.error).toHaveBeenCalledWith('3 of 3 rows could not be saved', expect.any(String));
    // every restore is a functional update: apply them in order to the batch's own result
    let state: Record<string, RowSelection> = { t1: shown('gl9', 'Fuel'), t2: shown('gl9', 'Fuel'), t3: shown('gl9', 'Fuel') };
    for (const [arg] of setRowSelections.mock.calls.slice(1)) state = (arg as (p: typeof state) => typeof state)(state);
    expect(state.t1!.entityId).toBe('old'); // had a selection: restored
    expect(state.t2).toBeUndefined(); // had none: removed
    expect(state.t3).toBeUndefined();
  });

  it('a refused single-row selection is rolled back; a saved one is left alone', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleRowEntityChange('t1', 'new', 'New');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const restore = setRowSelections.mock.calls.at(-1)![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>;
    expect(restore({ t1: shown('new', 'New') }).t1!.entityId).toBe('old');

    setRowSelections.mockClear(); toast.error.mockClear();
    vi.mocked(apiFetch).mockImplementation(async () => json());
    actions.handleRowEntityChange('t1', 'new', 'New');
    await vi.waitFor(() => expect(sentActions('save_selection').length).toBeGreaterThan(1));
    expect(setRowSelections).toHaveBeenCalledTimes(1); // only the optimistic update
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused dimension save is rolled back', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: { ...sel(), cc1Id: 'cc-old' } }, setRowSelections });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleRowDimensionChange('t1', 'cc-new', '', '');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const restore = setRowSelections.mock.calls.at(-1)![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>;
    expect(restore({ t1: { ...sel(), cc1Id: 'cc-new' } }).t1!.cc1Id).toBe('cc-old');
  });
});

describe('a rollback never overwrites a later edit', () => {
  const restoreOf = (setRowSelections: ReturnType<typeof vi.fn>) =>
    setRowSelections.mock.calls.at(-1)![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>;

  it('the refused save of edit A does not undo edit B made while A was in flight', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleRowEntityChange('t1', 'A', 'A');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const rollbackA = restoreOf(setRowSelections);
    // the row has since moved on to B (a later, successful edit): A's rollback must leave it alone
    const afterB = { t1: sel('B') };
    expect(rollbackA(afterB)).toBe(afterB);
    // and while the row still shows exactly A, it IS put back
    expect(rollbackA({ t1: shown('A', 'A') }).t1!.entityId).toBe('old');
    // a row removed meanwhile is not resurrected
    expect(rollbackA({})).toEqual({});
  });

  it('a Batch Edit rollback is per row: a row edited since keeps its newer value', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: {}, setRowSelections });
    actions.handleApplyBatchEdit('gl9', 'Fuel');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    let state: Record<string, RowSelection> = { t1: shown('gl9', 'Fuel'), t2: sel('newer'), t3: shown('gl9', 'Fuel') };
    for (const [arg] of setRowSelections.mock.calls.slice(1)) state = (arg as (p: typeof state) => typeof state)(state);
    expect(state.t2!.entityId).toBe('newer');
    expect(state.t1).toBeUndefined();
  });

  it('a VAT-only rollback restores only the VAT code', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: { ...sel('g1'), vatCode: 'S' as never } }, setRowSelections });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleRowVatChange('t1', 'none' as never);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const out = restoreOf(setRowSelections)({ t1: { ...sel('g1'), vatCode: 'none' as never, cc1Id: 'later-cc' } });
    expect(out.t1!.vatCode).toBe('S'); expect(out.t1!.cc1Id).toBe('later-cc');
  });
});

describe('cross-key guard: a batch holds its rows', () => {
  function slow() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async () => { await gate; return json({ deleted: 3, accepted: 3 }); });
    return release;
  }
  it('while Batch Allocate runs, a row Accept on one of its lines posts nothing and says why', async () => {
    const release = slow();
    const { actions } = setup();
    const batch = actions.handleBatchAccept();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(await actions.handleAccept('t2')).toBe(false);
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('already being processed'), expect.any(String));
    release(); await batch;
    expect(sentActions('allocate').filter((b) => b.bankTransactionId === 't2')).toHaveLength(1); // only the batch's own
  });
  it('while Batch Allocate runs, Mark as Reviewed and Delete on the same lines are refused', async () => {
    const release = slow();
    const { actions } = setup();
    const batch = actions.handleBatchAccept();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await actions.handleBulkAccept(); await actions.handleBatchDelete();
    release(); await batch;
    expect(sentActions('bulk_accept')).toHaveLength(0);
    expect(sentActions('delete')).toHaveLength(0);
  });
  it('a line outside the batch is free', async () => {
    const release = slow();
    const { actions } = setup({ selectedIds: new Set(['t1']) });
    const batch = actions.handleBatchAccept();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const other = actions.handleUnmatch('t3');
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    release(); await Promise.all([batch, other]);
    expect(sentActions('unmatch')).toHaveLength(1);
  });
});

describe('exclude: a refused second confirm leaves the first one\'s outcome alone', () => {
  it('the second handleExcludeConfirm does not settle(false) the promise of the exclude still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async () => { await gate; return json({ priorStatus: 'imported' }); });
    const settle = vi.fn(); const begin = vi.fn(() => Promise.resolve(true));
    const { actions, deps } = setup({ excludingTxId: 't1', excludeOutcome: { begin, settle } });
    const first = actions.handleExcludeConfirm('Personal');
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    // a second confirm for the same line while the first runs (a double click / Enter on the modal)
    (deps as { excludingTxId: string | null }).excludingTxId = 't1';
    const second = buildBankTxActions(deps as unknown as Parameters<typeof buildBankTxActions>[0]).handleExcludeConfirm('Personal');
    await second;
    expect(settle).not.toHaveBeenCalled(); // the first exclude's outcome is still pending, and stays so
    release(); await first;
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(true);
    expect(sentActions('exclude')).toHaveLength(1);
  });
});

describe('Batch Edit to a settlement type resets VAT', () => {
  it.each(['supplier', 'customer'] as const)('a row that had VAT "S" saves vatCode none when batch-edited to %s (a settlement carries no VAT)', async (type) => {
    vi.mocked(apiFetch).mockImplementation(async () => json());
    const setRowSelections = vi.fn();
    const { actions } = setup({ batchType: type, rowSelections: { t1: { ...sel('g1'), vatCode: 'S' as never } }, setRowSelections });
    actions.handleApplyBatchEdit('sup1', 'Acme');
    await vi.waitFor(() => expect(sentActions('save_selection')).toHaveLength(3));
    expect(sentActions('save_selection').every((b) => b.vatCode === undefined || b.vatCode === 'none')).toBe(true);
    const applied = (setRowSelections.mock.calls[0]![0] as () => Record<string, RowSelection>)();
    expect(applied.t1!.vatCode).toBe('none');
    expect(applied.t1!.type).toBe(type);
  });
  it('an account batch keeps the row\'s own VAT when the account has no default', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json());
    const setRowSelections = vi.fn();
    const { actions } = setup({ batchType: 'account', rowSelections: { t1: { ...sel('g1'), vatCode: 'S' as never } }, setRowSelections });
    actions.handleApplyBatchEdit('gl9', 'Fuel');
    const applied = (setRowSelections.mock.calls[0]![0] as () => Record<string, RowSelection>)();
    expect(applied.t1!.vatCode).toBe('S');
  });
});

describe('a rollback of one field never reverts an edit to another', () => {
  it('a refused entity change after a later VAT edit leaves the row as the user last had it', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleRowEntityChange('t1', 'A', 'A');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const rollback = setRowSelections.mock.calls.at(-1)![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>;
    const later = { t1: { ...shown('A', 'A'), vatCode: 'S' as never } }; // the user then changed the VAT on the optimistic row
    expect(rollback(later)).toBe(later);
  });
});

describe('a rollback after a row-REPLACING edit brings back its cost centres', () => {
  const dims = { cc1Id: 'cc1', cc2Id: 'cc2', buId: 'bu1' };
  const before: RowSelection = { ...sel('old'), ...dims };
  const restore = (setRowSelections: ReturnType<typeof vi.fn>) =>
    setRowSelections.mock.calls.at(-1)![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>;
  const sentDims = (o: RowSelection) => [o.cc1Id, o.cc2Id, o.buId];

  it('a refused type change: the row shows its cost centres again, so a later Accept does not post without them', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: before }, setRowSelections });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleRowTypeChange('t1', 'supplier');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    // the optimistic row (type switched, dimensions dropped) is what the rollback is applied to
    const optimistic = (setRowSelections.mock.calls[0]![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>)({ t1: before }).t1!;
    expect(sentDims(optimistic)).toEqual([undefined, undefined, undefined]);
    const out = restore(setRowSelections)({ t1: optimistic }).t1!;
    expect(out.type).toBe('account'); expect(out.entityId).toBe('old');
    expect(sentDims(out)).toEqual(['cc1', 'cc2', 'bu1']);
  });

  it('a refused Batch Edit restores each row\'s cost centres', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: before }, setRowSelections });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleApplyBatchEdit('sup1', 'Acme');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    let state = (setRowSelections.mock.calls[0]![0] as () => Record<string, RowSelection>)();
    expect(sentDims(state.t1!)).toEqual([undefined, undefined, undefined]);
    for (const [arg] of setRowSelections.mock.calls.slice(1)) state = (arg as (p: typeof state) => typeof state)(state);
    expect(state.t1!.entityId).toBe('old');
    expect(sentDims(state.t1!)).toEqual(['cc1', 'cc2', 'bu1']);
  });

  it('a refused create-entity allocation restores the cost centres', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: before }, setRowSelections, createEntityTxId: 't1' });
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleCreateEntityDone({ id: 'e1', name: 'New Co' }, 'supplier', vi.fn(), vi.fn(), vi.fn());
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const optimistic = (setRowSelections.mock.calls[0]![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>)({ t1: before }).t1!;
    const out = restore(setRowSelections)({ t1: optimistic }).t1!;
    expect(sentDims(out)).toEqual(['cc1', 'cc2', 'bu1']);
  });
});

describe('exclude refused because a ROW hold, not the same key', () => {
  it('releases the grid\'s outcome (settle(false)) and tells the user; the same-key refusal still does not settle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async () => { await gate; return json({ accepted: 3 }); });
    const settle = vi.fn(); const begin = vi.fn(() => Promise.resolve(true));
    const { actions } = setup({ excludingTxId: 't1', excludeOutcome: { begin, settle } });
    const batch = actions.handleBulkAccept(); // holds t1, t2, t3 (key "review")
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await actions.handleExcludeConfirm('Personal'); // different key, held row
    expect(settle).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledWith(false);
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('already being processed'), expect.any(String));
    expect(sentActions('exclude')).toHaveLength(0);
    release(); await batch;
  });
});

describe('rollback by per-edit sequence and field group', () => {
  const lastRollback = (fn: ReturnType<typeof vi.fn>, from = 0) => fn.mock.calls.slice(from).at(-1)![0] as (p: Record<string, RowSelection>) => Record<string, RowSelection>;

  it('re-picking the SAME value later: the first save failing late does not undo the row the user has now', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
    let failFirst!: () => void;
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => {
      n += 1;
      if (n === 1) return new Promise<Response>((r) => { failFirst = () => r(refuse()); }); // edit 1: fails LATE
      return json();
    });
    actions.handleRowEntityChange('t1', 'X', 'X'); // edit 1 (A)
    actions.handleRowEntityChange('t1', 'Y', 'Y'); // edit 2
    actions.handleRowEntityChange('t1', 'X', 'X'); // edit 3: the SAME value as edit 1, saved fine
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    const calls = setRowSelections.mock.calls.length;
    failFirst();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    await settleIO();
    // edit 1 is no longer the row's newest edit, so its late failure puts nothing back - whatever it is applied to
    const now = { t1: shown('X', 'X') }; // value-equal to edit 1's patch
    let state: Record<string, RowSelection> = now;
    for (const [arg] of setRowSelections.mock.calls.slice(calls)) state = (arg as (p: typeof state) => typeof state)(state);
    expect(state).toEqual(now);
  });

  it('a cost-centre edit made meanwhile neither blocks nor is reverted by a failed allocation edit', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: { ...sel('old'), cc1Id: 'cc-old' } }, setRowSelections });
    let failFirst!: () => void; let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => { n += 1; return n === 1 ? new Promise<Response>((r) => { failFirst = () => r(refuse()); }) : json(); });
    actions.handleRowEntityChange('t1', 'A', 'A');
    actions.handleRowDimensionChange('t1', 'cc-new', '', '');
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const calls = setRowSelections.mock.calls.length;
    failFirst();
    await vi.waitFor(() => expect(setRowSelections.mock.calls.length).toBeGreaterThan(calls));
    const out = lastRollback(setRowSelections, calls)({ t1: { ...shown('A', 'A'), cc1Id: 'cc-new' } }).t1!;
    expect(out.entityId).toBe('old'); // the allocation edit IS rolled back
    expect(out.cc1Id).toBe('cc-new'); // the later cost-centre edit survives
  });

  it('a row with NO prior selection: the rollback keeps cost centres set since instead of deleting the whole row', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: {}, setRowSelections });
    let failFirst!: () => void; let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => { n += 1; return n === 1 ? new Promise<Response>((r) => { failFirst = () => r(refuse()); }) : json(); });
    actions.handleRowEntityChange('t1', 'A', 'A');
    actions.handleRowDimensionChange('t1', 'cc-new', '', '');
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const calls = setRowSelections.mock.calls.length;
    failFirst();
    await vi.waitFor(() => expect(setRowSelections.mock.calls.length).toBeGreaterThan(calls));
    const out = lastRollback(setRowSelections, calls)({ t1: { ...shown('A', 'A'), cc1Id: 'cc-new' } }).t1!;
    expect(out.entityId).toBe(''); expect(out.cc1Id).toBe('cc-new');
    // and with nothing set since, the row is removed
    expect(lastRollback(setRowSelections, calls)({ t1: shown('A', 'A') }).t1).toBeUndefined();
  });
});

describe('X1: an exclude refused by a row hold releases the keyboard grid (the real outcome hook)', () => {
  it('handleExclude\'s promise resolves false at once instead of hanging until a timeout', async () => {
    const { useBankTxOutcome } = await import('@/components/accounting/bank-transactions/useBankTxOutcome');
    const outcome = renderHook(() => useBankTxOutcome());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async () => { await gate; return json({ accepted: 3 }); });
    const { deps } = setup({ excludingTxId: null, excludeOutcome: outcome.result.current });
    let excluding: string | null = null;
    (deps as { setExcludingTxId: (v: string | null) => void }).setExcludingTxId = (v) => { excluding = v; };
    const actions = buildBankTxActions({ ...(deps as object), get excludingTxId() { return excluding; } } as unknown as Parameters<typeof buildBankTxActions>[0]);
    const batch = actions.handleBulkAccept(); // holds t1..t3
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const wait = actions.handleExclude('t1'); // the grid awaits this
    await actions.handleExcludeConfirm('Personal');
    expect(await Promise.race([wait, new Promise((r) => setTimeout(() => r('HUNG'), 200))])).toBe(false);
    release(); await batch;
  });
});

describe('rollback goes to the last SAVED value, not to the previous snapshot', () => {
  /** Edits whose saves the test answers by hand, in any order. */
  function manual() {
    const answers: Array<(ok: boolean) => void> = [];
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((r) => { answers.push((ok) => r(ok ? json() : refuse())); }));
    return answers;
  }
  const apply = (setRowSelections: ReturnType<typeof vi.fn>, from: number, state: Record<string, RowSelection>) => {
    for (const [arg] of setRowSelections.mock.calls.slice(from)) state = (arg as (p: typeof state) => typeof state)(state);
    return state;
  };

  it.each([['edit 1 answers first', [0, 1]], ['edit 2 answers first', [1, 0]]] as const)(
    'X then Y, BOTH refused late (%s): the row goes back to what the server holds, never to X', async (_n, order) => {
      const setRowSelections = vi.fn();
      const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
      const answers = manual();
      actions.handleRowEntityChange('t1', 'X', 'X');
      actions.handleRowEntityChange('t1', 'Y', 'Y');
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      const from = setRowSelections.mock.calls.length;
      let state: Record<string, RowSelection> = { t1: shown('Y', 'Y') };
      for (const i of order) { answers[i]!(false); await vi.waitFor(() => expect(toast.error.mock.calls.length).toBeGreaterThan(order.indexOf(i))); }
      await settleIO();
      state = apply(setRowSelections, from, state);
      expect(state.t1!.entityId).toBe('old');
    });

  it('X saved, then Y refused: the row goes back to X (the last value the server confirmed)', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
    const answers = manual();
    actions.handleRowEntityChange('t1', 'X', 'X');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers[0]!(true);
    await vi.waitFor(() => expect(trackedEditCount()).toBe(0));
    actions.handleRowEntityChange('t1', 'Y', 'Y');
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    const from = setRowSelections.mock.calls.length;
    answers[1]!(false);
    await vi.waitFor(() => expect(setRowSelections.mock.calls.length).toBeGreaterThan(from));
    expect(apply(setRowSelections, from, { t1: shown('Y', 'Y') }).t1!.entityId).toBe('old');
  });

  it('the fallback follows saves within a burst: X stored while Y is pending, then Y refused -> X', async () => {
    const setRowSelections = vi.fn();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections });
    const answers = manual();
    actions.handleRowEntityChange('t1', 'X', 'X');
    actions.handleRowEntityChange('t1', 'Y', 'Y');
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[0]!(true); // X stored (a superseded edit that still reached the server)
    await vi.waitFor(() => expect(trackedEditCount()).toBeGreaterThan(0));
    const from = setRowSelections.mock.calls.length;
    answers[1]!(false);
    await vi.waitFor(() => expect(setRowSelections.mock.calls.length).toBeGreaterThan(from));
    expect(apply(setRowSelections, from, { t1: shown('Y', 'Y') }).t1!.entityId).toBe('X');
  });
});

describe('the edit tracker does not grow: entries go when their last edit is answered', () => {
  it('saved and refused edits both leave nothing behind', async () => {
    const before = trackedEditCount();
    const { actions } = setup({ rowSelections: { t1: sel('old') }, setRowSelections: vi.fn() });
    vi.mocked(apiFetch).mockImplementation(async () => json());
    actions.handleRowEntityChange('t1', 'A', 'A'); actions.handleRowDimensionChange('t1', 'cc', '', '');
    await vi.waitFor(() => expect(trackedEditCount()).toBe(before));
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    actions.handleRowEntityChange('t2', 'B', 'B'); actions.handleRowDimensionChange('t2', 'cc', '', '');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(trackedEditCount()).toBe(before);
  });
});

describe('every request inside an action is activity for the hold timer', () => {
  it('a bulk action touches the busy hook when its request starts and when it finishes', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ accepted: 3 }));
    await setup().actions.handleBulkAccept();
    expect(touchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // ... naming the lines the request is about, so only the operation holding them is kept alive
    expect(touchSpy.mock.calls[0]![0]).toEqual({ rows: ['t1', 't2', 't3'] }); // at the start
    expect(touchSpy.mock.calls.at(-1)![0]).toEqual({ rows: ['t1', 't2', 't3'] }); // and at the finish
  });
});

