/**
 * D2 round 3: useBankTxActions. A failed smart-categorise must not be followed by the success toast
 * "No new categorisations found" (the categoriser never ran); selection / cost-centre saves that the
 * server refuses must tell the user; a bulk accept answered with an empty 500 shows a plain sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const { notify } = vi.hoisted(() => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';

useApiJsonOverMock();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refuse = (m: string, status = 400) => json({ success: false, error: { code: 'BAD_REQUEST', message: m } }, status);
const loadTransactions = vi.fn();

const actions = () => buildBankTxActions({
  transactions: [], glAccounts: [], selectedBank: 'bank-1', selectedIds: new Set(['t1']), rowSelections: {},
  batchType: 'account', excludingTxId: null, createEntityTxId: null, setSmartRunning: vi.fn(), setRowSelections: vi.fn(),
  setTransactions: vi.fn(), setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(),
  loadTransactions, refreshBankAccounts: vi.fn(),
} as never);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('handleApplyRules', () => {
  it('rules apply, smart-categorise is refused: the error shows and no false success toast follows', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => String(url).includes('smart-categorize')
      ? refuse('D2 server says no: categoriser offline', 503) : json({ success: true, data: { applied: 0 } }));
    await actions().handleApplyRules();
    expect(notify.error).toHaveBeenCalledWith('D2 server says no: categoriser offline');
    expect(notify.success).not.toHaveBeenCalledWith('No new categorisations found');
    expect(loadTransactions).toHaveBeenCalled();   // the rules did apply: the list refreshes
  });

  it('both succeed with nothing to do: the honest "No new categorisations found"', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ success: true, data: { applied: 0, categorized: 0 } }));
    await actions().handleApplyRules();
    expect(notify.success).toHaveBeenCalledWith('No new categorisations found');
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('the rules call refused: server message; empty 500: plain sentence', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => refuse('D2 server says no: rules locked'));
    await actions().handleApplyRules();
    expect(notify.error).toHaveBeenCalledWith('D2 server says no: rules locked');
    notify.error.mockClear();
    vi.mocked(apiFetch).mockImplementation(async () => new Response('', { status: 500 }));
    await actions().handleApplyRules();
    expect(notify.error).toHaveBeenCalledWith('Could not apply the rules - try again');
  });
});

describe('row saves and bulk accept', () => {
  it('a refused selection save and a refused cost-centre save both tell the user', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => refuse('D2 server says no: transaction is reconciled', 409));
    actions().saveSelection('t1', 'account', 'a1');
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('D2 server says no: transaction is reconciled'));
    notify.error.mockClear();
    actions().saveDimensions('t1', 'c1', '', '');
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('D2 server says no: transaction is reconciled'));
  });

  it('a good selection save is silent', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ success: true, data: {} }));
    actions().saveSelection('t1', 'account', 'a1');
    await new Promise(r => setTimeout(r, 20));
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('bulk accept: empty 500 gives a plain sentence, never a JSON parse error', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('', { status: 500 }));
    // only actionable (non-pending-feed) transactions are accepted: give it one
    const withTx = buildBankTxActions({
      transactions: [{ id: 't1', status: 'pending', amount: 1 }], glAccounts: [], selectedBank: 'bank-1', selectedIds: new Set(['t1']),
      rowSelections: {}, batchType: 'account', excludingTxId: null, createEntityTxId: null, setSmartRunning: vi.fn(),
      setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(),
      setExcludingTxId: vi.fn(), loadTransactions, refreshBankAccounts: vi.fn(),
    } as never);
    await withTx.handleBulkAccept();
    expect(notify.error).toHaveBeenCalledWith('Could not mark the transactions as reviewed - try again');
  });
});
