/**
 * D2 round 6 (g2): useBankTxActions. A smart-categorise 2xx that is not JSON is a failure (not "timed out" plus a
 * success toast), a failed smart run still reports the rules that applied, a batch accept where every call failed
 * never toasts green, and a note save / a refused action shows the SERVER message (not a bare "Failed ...").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const { notify } = vi.hoisted(() => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';

useApiJsonOverMock();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refuse = (m: string, status = 400) => json({ success: false, error: { code: 'BAD_REQUEST', message: m } }, status);
const loadTransactions = vi.fn();
const sel = { type: 'account', entityId: 'gl-1', label: '6000 Rent', vatCode: 'none' };

const actions = (selected = ['t1'], rowSelections: Record<string, unknown> = {}) => buildBankTxActions({
  transactions: [], glAccounts: [], selectedBank: 'bank-1', selectedIds: new Set(selected), rowSelections, batchType: 'account',
  excludingTxId: null, createEntityTxId: null, setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(),
  setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(),
  loadTransactions, refreshBankAccounts: vi.fn(),
} as never);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('handleApplyRules with a broken smart-categorise', () => {
  it('a 2xx that is not JSON is a failure: error shown, the rules that applied are still reported, no "No new categorisations"', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => String(url).includes('smart-categorize')
      ? new Response('<html>proxy page</html>', { status: 200 }) : json({ success: true, data: { applied: 3 } }));
    await actions().handleApplyRules();
    expect(notify.error).toHaveBeenCalledWith('Smart categorisation could not run - try again');
    expect(notify.success).toHaveBeenCalledWith('3 rules applied');
    expect(notify.success).not.toHaveBeenCalledWith('No new categorisations found');
    expect(loadTransactions).toHaveBeenCalled();
  });

  it('a refused smart call with no rules applied: only the server message', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => String(url).includes('smart-categorize')
      ? refuse('D2 categoriser offline', 503) : json({ success: true, data: { applied: 0 } }));
    await actions().handleApplyRules();
    expect(notify.error).toHaveBeenCalledWith('D2 categoriser offline');
    expect(notify.success).not.toHaveBeenCalledWith('0 rules applied');
  });

  it('a timeout (abort) is still not an error', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('smart-categorize')) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return json({ success: true, data: { applied: 0 } });
    });
    await actions().handleApplyRules();
    expect(notify.error).not.toHaveBeenCalled();
  });
});

describe('handleBatchAccept', () => {
  const body = (u: unknown) => String(u);
  it('every call refused: an error with the first server reason, never a green toast', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => refuse('D2 period is locked'));
    await actions(['t1', 't2'], { t1: sel, t2: sel }).handleBatchAccept();
    expect(notify.error).toHaveBeenCalledWith('No transactions were allocated: D2 period is locked');
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('every call an empty 500: a plain sentence', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('', { status: 500 }));
    await actions(['t1'], { t1: sel }).handleBatchAccept();
    expect(notify.error).toHaveBeenCalledWith('No transactions were allocated: Could not complete the action - try again');
    expect(body(notify.error.mock.calls[0])).not.toMatch(/HTTP \d|JSON|Unexpected end/);
  });

  it('some refused: a warning (not success) naming the count and the reason', async () => {
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => (++n === 1 ? json({ success: true, data: {} }) : refuse('D2 account is inactive')));
    await actions(['t1', 't2'], { t1: sel, t2: sel }).handleBatchAccept();
    expect(notify.warning).toHaveBeenCalledWith('1 allocated, 1 could not be allocated', 'D2 account is inactive');
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('all good: the success toast', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ success: true, data: {} }));
    await actions(['t1'], { t1: sel }).handleBatchAccept();
    expect(notify.success).toHaveBeenCalledWith('1 allocated');
    expect(notify.error).not.toHaveBeenCalled();
  });
});

describe('handleUpdateNotes and a 2xx refusal', () => {
  it('a refused note save shows the server message and reloads', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => refuse('D2 note too long'));
    await actions().handleUpdateNotes('t1', 'x');
    expect(notify.error).toHaveBeenCalledWith('D2 note too long');
    expect(loadTransactions).toHaveBeenCalled();
  });

  it('an empty 500 on the note: a plain sentence, not "Failed to save note"', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('', { status: 500 }));
    await actions().handleUpdateNotes('t1', 'x');
    expect(notify.error).toHaveBeenCalledWith('Could not save the note - try again');
  });

  it('a 2xx { success:false } on exclude shows its message (not the generic fallback)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ success: false, error: { message: 'D2 already reconciled' } }));
    await actions().handleExcludeConfirm('why');   // no excludingTxId: nothing is sent
    expect(notify.error).not.toHaveBeenCalled();
    await actions().handleUnmatch('t1');
    expect(notify.error).toHaveBeenCalledWith('D2 already reconciled');
  });
});
