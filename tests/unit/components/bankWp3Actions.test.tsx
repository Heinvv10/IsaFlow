/**
 * WP3 (UI safety), the REAL action handlers with only the network mocked: bulk actions act on rows ON SCREEN only,
 * Delete reports the server's {deleted}, every mutating button refuses a second click while it runs, Batch Allocate shows
 * progress, Unmatch on a reviewed row asks first, Batch Edit persists, and a refused save puts the row back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), undoable: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { selectedOnScreen, pruneSelection } from '@/components/accounting/bank-transactions/bankTxSelectionView';
import type { BankTxBusy } from '@/components/accounting/bank-transactions/useBankTxBusy';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

const json = (data: unknown = {}) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { message: 'refused' } }), { status: 400 });
const tx = (id: string, extra: Partial<BankTx> = {}) => ({ id, description: id, amount: -5, transactionDate: '2026-01-01', status: 'imported', feedState: 'posted', ...extra }) as BankTx;
const sel = (entityId = 'gl1'): RowSelection => ({ type: 'account', entityId, label: 'Telephone', vatCode: 'none' });

/** A real busy guard (the page's hook, minus React): one key at a time. */
function busyGuard() {
  const running = new Set<string>();
  const progress: Array<unknown> = [];
  const busy: BankTxBusy = {
    busy: running, isBusy: (k) => running.has(k), progress: null,
    setProgress: (p) => { progress.push(p); },
    run: async (key, fn) => { if (running.has(key)) return undefined; running.add(key); try { return await fn(); } finally { running.delete(key); } },
  };
  return { busy, progress };
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
  return { deps, progress: g.progress, actions: buildBankTxActions(deps as unknown as Parameters<typeof buildBankTxActions>[0]) };
}
const bodies = () => vi.mocked(apiFetch).mock.calls.map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>; } catch { return {}; } });
const sentActions = (action: string) => bodies().filter((b) => b.action === action);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
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
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(3));
    // every restore is a functional update: apply them in order to the batch's own result
    let state: Record<string, RowSelection> = { t1: sel('gl9'), t2: sel('gl9'), t3: sel('gl9') };
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
    expect(restore({ t1: sel('new') }).t1!.entityId).toBe('old');

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
