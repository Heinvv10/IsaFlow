/**
 * UXB (wave 5): the row actions tell the keyboard grid whether the row was really done. Accept resolves true as soon
 * as the allocate request succeeded, and BEFORE the list reloads (the grid marks the row acted on first, then the
 * reload removes it); false on refusal or a missing selection. Exclude resolves true on a confirmed exclude and false
 * when the modal is closed or the request fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const { notify } = vi.hoisted(() => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), undoable: vi.fn() },
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { useBankTxOutcome } from '@/components/accounting/bank-transactions/useBankTxOutcome';
import { renderHook, act } from '@testing-library/react';

useApiJsonOverMock();

const TX = { id: 'tx-1', status: 'imported', transactionDate: '2026-06-01', amount: -10, description: '' };
const ACTION = '/api/accounting/bank-transactions-action';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const events: string[] = [];

function actions(over: { entityId?: string; outcome?: ReturnType<typeof useBankTxOutcome>; excludingTxId?: string | null } = {}) {
  return buildBankTxActions({
    transactions: [TX], glAccounts: [], bankAccounts: [{ id: 'bank-1' }], selectedBank: 'bank-1', selectedIds: new Set(),
    rowSelections: { [TX.id]: { type: 'account', entityId: over.entityId ?? 'gl-1', label: 'x', vatCode: 'none' } },
    batchType: 'account', excludingTxId: over.excludingTxId ?? null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(),
    setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(), excludeOutcome: over.outcome,
    loadTransactions: () => { setTimeout(() => events.push('reload'), 0); }, // the list lands later: it is a network round trip refreshBankAccounts: vi.fn(), reloadCurrentView: vi.fn(),
  } as never);
}

function serve(action: 'ok' | 'refuse') {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url) !== ACTION) return json({ success: true, data: { matchCount: 0 } });
    return action === 'ok'
      ? json({ success: true, data: { journalEntryId: 'j-1', priorStatus: 'imported' } })
      : json({ success: false, error: { code: 'REFUSED', message: 'no' } }, 422);
  });
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(apiFetch).mockReset(); events.length = 0; });

describe('handleAccept', () => {
  it('resolves true once the allocate request succeeded, before the reloaded list lands', async () => {
    serve('ok');
    const done = actions().handleAccept(TX.id).then((ok) => { events.push(`resolved ${ok}`); return ok; });
    await done;
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['resolved true', 'reload']);
  });

  it('resolves false when the server refuses', async () => {
    serve('refuse');
    expect(await actions().handleAccept(TX.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).not.toContain('reload');
  });

  it('resolves false with nothing chosen, and posts nothing', async () => {
    serve('ok');
    expect(await actions({ entityId: '' }).handleAccept(TX.id)).toBe(false);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
});

describe('handleExclude', () => {
  it('resolves true on a confirmed exclude, false when the modal is closed', async () => {
    serve('ok');
    const { result } = renderHook(() => useBankTxOutcome());
    const a = actions({ outcome: result.current, excludingTxId: TX.id });
    const confirmed = a.handleExclude(TX.id);
    await act(async () => { await a.handleExcludeConfirm('Duplicate'); });
    expect(await confirmed).toBe(true);

    const closed = a.handleExclude(TX.id);
    a.handleExcludeClose();
    expect(await closed).toBe(false);
  });

  it('resolves false when the exclude request fails', async () => {
    serve('refuse');
    const { result } = renderHook(() => useBankTxOutcome());
    const a = actions({ outcome: result.current, excludingTxId: TX.id });
    const p = a.handleExclude(TX.id);
    await act(async () => { await a.handleExcludeConfirm('Duplicate'); });
    expect(await p).toBe(false);
  });
});
