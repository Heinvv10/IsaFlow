/**
 * Master plan U (M9, decision 4): Undo on the bank transactions page. Offered after a single-row allocate of an account
 * that is not a bank, or of a supplier, and after excluding a line the SERVER says was `imported`. Nowhere else. The
 * client checks nothing before `reverse`: the undo names the journal and the server compares under the row lock, so a
 * refusal has to reach the user, with the view reloaded behind it.
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
const CHANGED = 'This line has changed since you allocated it.';
const reloadCurrentView = vi.fn();
const loadTransactions = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (message: string, status: number) => json({ success: false, error: { code: 'REFUSED', message } }, status);

type Sel = { type: string; entityId: string; label: string; vatCode: string };
const account: Sel = { type: 'account', entityId: 'gl-1', label: '5000 Fuel', vatCode: 'none' };
const supplier: Sel = { type: 'supplier', entityId: 's-1', label: 'Shell', vatCode: 'none' };

function actions(sel: Sel = account, excludingTxId: string | null = null, tx = TX) {
  return buildBankTxActions({
    transactions: [tx], glAccounts: [], bankAccounts: [{ id: 'bank-1' }, { id: 'bank-2' }], selectedBank: 'bank-1', selectedIds: new Set(),
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

/** Answers the page's own calls. `prior` is the status the server read under the lock when it excluded the line. */
function serve(opts: { reverse?: () => Response; unmatch?: () => Response; allocated?: unknown; prior?: string } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url) !== ACTION) return ok({ matchCount: 0 });
    const body = JSON.parse(String(init?.body)) as { action: string };
    if (body.action === 'allocate') return ok(opts.allocated ?? { journalEntryId: JOURNAL });
    if (body.action === 'exclude') return ok({ id: TX.id, priorStatus: opts.prior ?? 'imported' });
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

  it('Undo sends reverse once, naming the journal, and refreshes the view the user is on now', async () => {
    serve();
    await actions().handleAccept(TX.id);
    loadTransactions.mockClear();
    await offered().onUndo();
    expect(sent('reverse')).toEqual([{ action: 'reverse', bankTransactionId: TX.id, expectedJournalEntryId: JOURNAL }]);
    expect(notify.success).toHaveBeenCalledWith('Allocation undone');
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
    expect(loadTransactions, 'the render that accepted may hold an older tab').not.toHaveBeenCalled();
  });

  it('asks the list nothing first: the server compares under the lock, and a re-read called a reviewed line changed', async () => {
    serve();
    await actions().handleAccept(TX.id);
    vi.mocked(apiFetch).mockClear();
    await offered().onUndo();
    expect(vi.mocked(apiFetch).mock.calls.map(([u]) => String(u))).toEqual([ACTION]);
  });

  it.each([
    ['the server finding the line changed', CHANGED, 409],
    ['a 403 from a control', 'You allocated this line, so someone else must reverse it.', 403],
  ])('%s: shows the sentence, no success, and reloads the view that is out of date', async (_n, message, status) => {
    serve({ reverse: () => refuse(message, status) });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(sent('reverse')).toHaveLength(1);
    expect(notify.error).toHaveBeenCalledWith(message);
    expect(notify.success).not.toHaveBeenCalled();
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
  });

  it('a contra dated as the journal it reverses is a plain success', async () => {
    serve({ reverse: () => ok({ reversed: true, originalEntryDate: '2026-06-01', reversalEntryDate: '2026-06-01', vatLockRoll: null }) });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(notify.warning).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Allocation undone');
  });

  it.each([
    ['a locked VAT period', { reason: 'VAT period locked' }, /locked VAT period/],
    ['a closed period', null, /closed period/],
  ])('a contra moved by %s warns, with both dates, instead of a success', async (_n, vatLockRoll, why) => {
    serve({ reverse: () => ok({ reversed: true, originalEntryDate: '2026-06-01', reversalEntryDate: '2026-11-01', vatLockRoll }) });
    await actions().handleAccept(TX.id);
    await offered().onUndo();
    expect(notify.success).not.toHaveBeenCalled();
    const [title, message] = notify.warning.mock.calls[0]! as [string, string];
    expect(title).toBe('Allocation undone. The contra is dated 01 Nov 2026');
    expect(message).toContain('01 Jun 2026');
    expect(message).toMatch(why);
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
  });

  it('an account allocation says what was learned is kept', async () => {
    serve();
    await actions().handleAccept(TX.id);
    expect(offered().message).toMatch(/learned from this allocation is kept/i);
  });

  it('a supplier allocation learns nothing, so it says nothing about learning', async () => {
    serve();
    await actions(supplier).handleAccept(TX.id);
    expect(offered().message).toBeUndefined();
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('smart-categorize'))).toBe(false);
  });

  it('a supplier line offers Undo: the reversal refuses one whose credit a refund spent', async () => {
    serve();
    await actions(supplier).handleAccept(TX.id);
    expect(notify.undoable).toHaveBeenCalledTimes(1);
  });

  it('no journal in the response: nothing to name, so no Undo', async () => {
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

  it('a customer line offers none: the customer unwind has no guard for credit a refund already spent', async () => {
    serve();
    await actions({ type: 'customer', entityId: 'c-1', label: 'Acme', vatCode: 'none' }).handleAccept(TX.id);
    expect(notify.undoable).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Transaction allocated');
  });

  it('an account selection that is a bank is a transfer in all but name, and offers none', async () => {
    serve();
    await actions({ type: 'account', entityId: 'bank-2', label: '1010 Savings', vatCode: 'none' }).handleAccept(TX.id);
    expect(notify.undoable).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Transaction allocated');
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

  it.each(['matched', 'reconciled', 'provisional'])('a line the server read as %s offers no Undo, whatever the grid showed', async (prior) => {
    serve({ prior });
    await actions(account, TX.id).handleExcludeConfirm('Duplicate');
    expect(notify.undoable).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Transaction excluded');
  });

  it('a line the server read as imported offers Undo, whatever a stale grid showed', async () => {
    serve();
    await actions(account, TX.id, { ...TX, status: 'matched' }).handleExcludeConfirm('Duplicate');
    expect(notify.undoable).toHaveBeenCalledTimes(1);
  });

  it('says a rejected suggestion stays rejected: the decision log never re-opens a decided row', async () => {
    serve();
    await actions(account, TX.id).handleExcludeConfirm('Duplicate');
    expect(offered().message).toMatch(/stays recorded as rejected/i);
  });

  it('the server finding the line has moved on shows its sentence for an exclude, and reloads the view', async () => {
    const message = 'This line has changed since you excluded it.';
    serve({ unmatch: () => refuse(message, 409) });
    await actions(account, TX.id).handleExcludeConfirm('Duplicate');
    await offered().onUndo();
    expect(notify.error).toHaveBeenCalledWith(message);
    expect(notify.success).not.toHaveBeenCalled();
    expect(reloadCurrentView).toHaveBeenCalledTimes(1);
  });

  it('a refused restore shows the refusal', async () => {
    serve({ unmatch: () => refuse('This line is on a completed reconciliation', 409) });
    await actions(account, TX.id).handleExcludeConfirm('Duplicate');
    await offered().onUndo();
    expect(notify.error).toHaveBeenCalledWith('This line is on a completed reconciliation');
    expect(notify.success).not.toHaveBeenCalled();
  });
});
