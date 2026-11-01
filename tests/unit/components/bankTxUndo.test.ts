/**
 * Master plan U (M9, decision 4): Undo on the bank transactions page. Offered after a single-row allocate and
 * after excluding an `imported` line, nowhere else. The re-read before `reverse` is what stops a toast from
 * reversing a journal that is no longer the one it offered to undo; `reverse` itself stays the unchanged choke
 * point, so a control's refusal has to reach the user.
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

useApiJsonOverMock();

const TX = { id: 'tx-1', status: 'imported', transactionDate: '2026-06-01', amount: -1234.5, description: 'WOOLWORTHS' };
const JOURNAL = 'journal-1';
const ACTION = '/api/accounting/bank-transactions-action';
const reloadCurrentView = vi.fn();
const loadTransactions = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (message: string, status: number) => json({ success: false, error: { code: 'REFUSED', message } }, status);

type Sel = { type: string; entityId: string; label: string; vatCode: string };
const account: Sel = { type: 'account', entityId: 'gl-1', label: '5000 Fuel', vatCode: 'none' };

function actions(sel: Sel = account, excludingTxId: string | null = null, tx = TX) {
  return buildBankTxActions({
    transactions: [tx], glAccounts: [], selectedBank: 'bank-1', selectedIds: new Set(),
    rowSelections: { [tx.id]: sel }, batchType: 'account', excludingTxId, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(),
    setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(),
    loadTransactions, refreshBankAccounts: vi.fn(), reloadCurrentView,
  } as never);
}

function actionBodies(): Array<Record<string, string>> {
  return vi.mocked(apiFetch).mock.calls
    .filter(([url]) => String(url) === ACTION)
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, string>);
}
const sent = (action: string) => actionBodies().filter((b) => b.action === action);

/** Answers the page's own calls. `line` is what the re-read of the line finds; `reverse` answers the reversal. */
function serve(opts: { line?: unknown; reverse?: () => Response; unmatch?: () => Response; allocated?: unknown } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/bank-transactions?')) return ok({ transactions: opts.line === undefined ? [] : [opts.line], total: 1 });
    if (u !== ACTION) return ok({ matchCount: 0 });
    const body = JSON.parse(String(init?.body)) as { action: string };
    if (body.action === 'allocate') return ok(opts.allocated ?? { journalEntryId: JOURNAL });
    if (body.action === 'reverse') return (opts.reverse ?? (() => ok({ reversed: true })))();
    if (body.action === 'unmatch') return (opts.unmatch ?? (() => ok({ id: TX.id })))();
    return ok({});
  });
}
const offered = () => notify.undoable.mock.calls[0]![1] as { onUndo: () => Promise<void>; message?: string };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(apiFetch).mockReset(); });

describe('Undo after a single-row allocate', () => {
  it('an allocate response offers Undo instead of the plain success', async () => {
    serve();
    await actions().handleAccept(TX.id);
    expect(notify.undoable).toHaveBeenCalledTimes(1);
    expect(notify.undoable.mock.calls[0]![0]).toBe('Transaction allocated');
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('Undo sends reverse once, for this line, and refreshes the view the user is on now', async () => {
    serve({ line: { id: TX.id, status: 'allocated', matchedJournalEntryId: JOURNAL } });
    await actions().handleAccept(TX.id);
    loadTransactions.mockClear();
    await offered().onUndo();
    expect(sent('reverse')).toEqual([{ action: 'reverse', bankTransactionId: TX.id, expectedJournalEntryId: JOURNAL }]);
    expect(notify.success).toHaveBeenCalledWith('Allocation undone');
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
    expect(loadTransactions, 'the render that accepted may hold an older tab').not.toHaveBeenCalled();
  });

  it('re-reads exactly this line: its bank account, its date, its amount, every status the screen lists', async () => {
    serve({ line: { id: TX.id, matchedJournalEntryId: JOURNAL } });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    const read = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/api/accounting/bank-transactions?'))!;
    const q = new URL(read, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      bank_account_id: 'bank-1', status: 'imported', from_date: '2026-06-01', to_date: '2026-06-01',
      from_amount: '-1234.5', to_amount: '-1234.5',
    });
  });

  it('a line whose journal changed sends no reverse and says so', async () => {
    serve({ line: { id: TX.id, status: 'allocated', matchedJournalEntryId: 'another-journal' } });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(sent('reverse')).toEqual([]);
    expect(notify.error).toHaveBeenCalledWith('This line has changed since you allocated it.');
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('a line that is no longer matched to anything sends no reverse', async () => {
    serve({ line: { id: TX.id, status: 'imported' } });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(sent('reverse')).toEqual([]);
    expect(notify.error).toHaveBeenCalledWith('This line has changed since you allocated it.');
  });

  it('a line the re-read cannot find (it moved on to matched or reconciled) sends no reverse', async () => {
    serve();
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(sent('reverse')).toEqual([]);
    expect(notify.error).toHaveBeenCalledWith('This line has changed since you allocated it.');
  });

  it('a neighbour with the same date and amount does not stand in for the line', async () => {
    serve({ line: { id: 'tx-2', status: 'allocated', matchedJournalEntryId: JOURNAL } });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(sent('reverse')).toEqual([]);
  });

  it('a re-read that fails sends no reverse and shows why', async () => {
    serve();
    await actions().handleAccept(TX.id);
    vi.mocked(apiFetch).mockImplementation(async () => refuse('The bank line could not be read', 503));
    await offered().onUndo();
    expect(sent('reverse')).toEqual([]);
    expect(notify.error).toHaveBeenCalledWith('The bank line could not be read');
  });

  it('a 403 from a control shows the refusal, not a success and not a generic failure', async () => {
    const message = 'You allocated this line, so someone else must reverse it.';
    serve({ line: { id: TX.id, matchedJournalEntryId: JOURNAL }, reverse: () => refuse(message, 403) });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(sent('reverse')).toHaveLength(1);
    expect(notify.error).toHaveBeenCalledWith(message);
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('the toast states that what was learned is kept', async () => {
    serve();
    await actions().handleAccept(TX.id);
    expect(offered().message).toMatch(/learned from this allocation is kept/i);
  });

  it('offers Undo on supplier and customer lines, which the reversal unwinds', async () => {
    serve();
    await actions({ type: 'supplier', entityId: 's-1', label: 'Shell', vatCode: 'none' }).handleAccept(TX.id);
    await actions({ type: 'customer', entityId: 'c-1', label: 'Acme', vatCode: 'none' }).handleAccept(TX.id);
    expect(notify.undoable).toHaveBeenCalledTimes(2);
  });

  it('no journal in the response: nothing to check against, so no Undo', async () => {
    serve({ allocated: { bankTransaction: {} } });
    await actions().handleAccept(TX.id);
    expect(notify.undoable).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Transaction allocated');
  });
});

describe('no Undo where the spec refuses one', () => {
  it('a transfer offers none', async () => {
    serve();
    await actions({ type: 'transfer', entityId: 'bank-2', label: 'Savings', vatCode: 'none' }).handleAccept(TX.id);
    expect(notify.undoable).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Transfer posted');
  });

  it('bulk_accept offers none', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ accepted: 1 }));
    const a = buildBankTxActions({
      transactions: [TX], selectedIds: new Set([TX.id]), setSelectedIds: vi.fn(), loadTransactions, refreshBankAccounts: vi.fn(),
    } as never);
    await a.handleBulkAccept();
    expect(notify.undoable).not.toHaveBeenCalled();
  });

  it('a batch allocate of several rows offers none', async () => {
    serve();
    const a = buildBankTxActions({
      transactions: [TX], selectedIds: new Set([TX.id]), rowSelections: { [TX.id]: account },
      setSelectedIds: vi.fn(), loadTransactions, refreshBankAccounts: vi.fn(),
    } as never);
    await a.handleBatchAccept();
    expect(notify.undoable).not.toHaveBeenCalled();
  });
});

describe('Undo after exclude', () => {
  it('excluding an imported line offers Undo, which sends unmatch once', async () => {
    serve();
    await actions(account, TX.id).handleExcludeConfirm('Duplicate');
    expect(notify.undoable.mock.calls[0]![0]).toBe('Transaction excluded');
    expect(notify.success).not.toHaveBeenCalled();
    await offered().onUndo();
    expect(sent('unmatch')).toEqual([{ action: 'unmatch', bankTransactionId: TX.id, expectedStatus: 'excluded' }]);
    expect(notify.success).toHaveBeenCalledWith('Transaction restored');
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
  });

  it.each(['matched', 'allocated', 'reconciled', 'provisional'])('excluding a %s line offers no Undo: unmatch would set it imported', async (status) => {
    serve();
    await actions(account, TX.id, { ...TX, status }).handleExcludeConfirm('Duplicate');
    expect(notify.undoable).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Transaction excluded');
  });

  it('the server finding the line has moved on shows the same sentence as the re-read', async () => {
    serve({ unmatch: () => refuse('This line has changed since you allocated it.', 409) });
    await actions(account, TX.id).handleExcludeConfirm('Duplicate');
    await offered().onUndo();
    expect(notify.error).toHaveBeenCalledWith('This line has changed since you allocated it.');
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('a refused restore shows the refusal', async () => {
    serve({ unmatch: () => refuse('This line is on a completed reconciliation', 409) });
    await actions(account, TX.id).handleExcludeConfirm('Duplicate');
    await offered().onUndo();
    expect(notify.error).toHaveBeenCalledWith('This line is on a completed reconciliation');
    expect(notify.success).not.toHaveBeenCalled();
  });
});
