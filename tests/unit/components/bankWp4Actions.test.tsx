/**
 * WP4a: lines that left the tab are taken off the screen by the action itself (removeRows), before the reload that tops the
 * page up answers: a single accept, Mark as Reviewed, Batch Allocate (the lines that posted) and Delete. A line that did NOT
 * leave (refused, or a count short of what was asked) stays; the reload decides. The reload and the summary run once.
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
import { useRemoveRows } from '@/components/accounting/bank-transactions/useRemoveRows';
import { useBankTxBusy } from '@/components/accounting/bank-transactions/useBankTxBusy';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

const json = (data: unknown = {}) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { message: 'refused' } }), { status: 400 });
const tx = (id: string) => ({ id, description: id, amount: -5, transactionDate: '2026-01-01', status: 'imported', feedState: 'posted' }) as BankTx;
const sel = (): RowSelection => ({ type: 'account', entityId: 'gl1', label: 'Telephone', vatCode: 'none' });

function setup() {
  const busy = renderHook(() => useBankTxBusy());
  const removeRows = vi.fn(), loadTransactions = vi.fn(), refreshBankAccounts = vi.fn();
  const deps = {
    transactions: [tx('t1'), tx('t2'), tx('t3')], glAccounts: [], bankAccounts: [], selectedBank: 'b1',
    selectedIds: new Set(['t1', 't2', 't3']), rowSelections: { t1: sel(), t2: sel(), t3: sel() }, batchType: 'account' as const,
    excludingTxId: null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(),
    setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(), loadTransactions, refreshBankAccounts, reloadCurrentView: vi.fn(),
    busy: { ...busy.result.current, run: (k: string, f: () => Promise<unknown>, r?: readonly string[]) => busy.result.current.run(k, f, r) }, removeRows,
  };
  return { removeRows, loadTransactions, refreshBankAccounts, actions: buildBankTxActions(deps as unknown as Parameters<typeof buildBankTxActions>[0]) };
}
beforeEach(() => { vi.mocked(apiFetch).mockReset(); Object.values(toast).forEach(f => f.mockReset()); vi.stubGlobal('confirm', () => true); });
const actionBody = (n: number) => JSON.parse(String((vi.mocked(apiFetch).mock.calls[n]![1] as RequestInit).body)) as Record<string, unknown>;

describe('removeRows', () => {
  it('a single accept removes the line the moment it posts; the list and the summary reload once each', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ journalEntryId: 'je1' }));
    const { actions, removeRows, loadTransactions, refreshBankAccounts } = setup();
    await actions.handleAccept('t1');
    expect(removeRows).toHaveBeenCalledWith(['t1']);
    expect(removeRows.mock.invocationCallOrder[0]!).toBeLessThan(loadTransactions.mock.invocationCallOrder[0]!);
    expect(loadTransactions).toHaveBeenCalledTimes(1); expect(refreshBankAccounts).toHaveBeenCalledTimes(1);
  });

  it('an accept the server refuses removes nothing', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => refuse());
    const { actions, removeRows } = setup();
    await actions.handleAccept('t1');
    expect(removeRows).not.toHaveBeenCalled();
  });

  it('Mark as Reviewed removes the lines when ALL were reviewed, and leaves the reload to decide when only some were', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ accepted: 3 }));
    let s = setup();
    await s.actions.handleBulkAccept();
    expect(s.removeRows).toHaveBeenCalledWith(['t1', 't2', 't3']);
    expect(s.loadTransactions).toHaveBeenCalledTimes(1); expect(s.refreshBankAccounts).toHaveBeenCalledTimes(1);
    vi.mocked(apiFetch).mockImplementation(async () => json({ accepted: 2 }));
    s = setup();
    await s.actions.handleBulkAccept();
    expect(s.removeRows).not.toHaveBeenCalled();
    expect(s.loadTransactions).toHaveBeenCalledTimes(1);
  });

  it('Batch Allocate removes exactly the lines that posted', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (JSON.parse(String((init as RequestInit).body)).bankTransactionId === 't2' ? refuse() : json({ journalEntryId: 'je' })));
    const { actions, removeRows, loadTransactions } = setup();
    await actions.handleBatchAccept();
    expect(removeRows).toHaveBeenCalledWith(['t1', 't3']);
    expect(loadTransactions).toHaveBeenCalledTimes(1);
  });

  it('Delete removes the lines only when the server deleted every one asked for', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ deleted: 3 }));
    let s = setup();
    await s.actions.handleBatchDelete();
    expect(s.removeRows).toHaveBeenCalledWith(['t1', 't2', 't3']);
    expect(actionBody(0)).toMatchObject({ action: 'delete' });
    vi.mocked(apiFetch).mockImplementation(async () => json({ deleted: 1 }));
    s = setup();
    await s.actions.handleBatchDelete();
    expect(s.removeRows).not.toHaveBeenCalled(); // 2 were refused: which ones is for the reload to say
  });
});

describe('useRemoveRows: the list and its count', () => {
  function rig(rows: BankTx[], total: number) {
    let txs = rows, loaded = { total };
    const setTransactions = vi.fn((fn: (p: BankTx[]) => BankTx[]) => { txs = fn(txs); });
    const setLoaded = vi.fn((fn: (l: { total: number }) => { total: number }) => { loaded = fn(loaded); });
    const hook = renderHook(() => useRemoveRows(txs, setTransactions as never, setLoaded as never));
    return { remove: (ids: string[]) => act(() => { hook.result.current(ids); }), rows: () => txs.map(t => t.id), total: () => loaded.total, setLoaded };
  }
  it('takes the named lines off the list and the count down by exactly that many', () => {
    const r = rig([tx('t1'), tx('t2'), tx('t3')], 60);
    r.remove(['t1', 't3']);
    expect(r.rows()).toEqual(['t2']); expect(r.total()).toBe(58);
  });
  it('ids that are not on this page change nothing: not the list, not the count', () => {
    const r = rig([tx('t1'), tx('t2')], 60);
    r.remove(['elsewhere-1', 'elsewhere-2']);
    expect(r.rows()).toEqual(['t1', 't2']); expect(r.total()).toBe(60);
    expect(r.setLoaded).not.toHaveBeenCalled();
  });
  it('a mix: only the lines that were here count', () => {
    const r = rig([tx('t1'), tx('t2')], 10);
    r.remove(['t1', 'gone']);
    expect(r.rows()).toEqual(['t2']); expect(r.total()).toBe(9);
  });
  it('the count never goes below zero', () => {
    const r = rig([tx('t1'), tx('t2')], 1);
    r.remove(['t1', 't2']);
    expect(r.total()).toBe(0);
  });
});

