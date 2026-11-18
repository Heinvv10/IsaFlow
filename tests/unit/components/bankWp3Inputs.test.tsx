/**
 * WP3: the amount inputs really debounce; the AI poll calls the LATEST loader each tick; removing an attachment asks first;
 * the Ask-client flow toasts, marks the row and ties its labels to its inputs.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { AMOUNT_DEBOUNCE_MS, DebouncedAmountInput } from '@/components/accounting/bank-transactions/DebouncedAmountInput';
import { useLlmResultPoll } from '@/components/accounting/bank-transactions/useLlmResultPoll';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import { BankTxQueryModal } from '@/components/accounting/BankTxQueryModal';
import { BankTxRowActions } from '@/components/accounting/bankTx/BankTxRowActions';
import type { BankTx } from '@/components/accounting/BankTxTable';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe('DebouncedAmountInput', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

  it('typing "1250" commits ONCE, 500 ms after the last keystroke - not once per keystroke', () => {
    const onCommit = vi.fn();
    render(<DebouncedAmountInput id="min" label="Min R" value="" placeholder="0" onCommit={onCommit} />);
    const input = screen.getByLabelText('Min R') as HTMLInputElement;
    for (const v of ['1', '12', '125', '1250']) { fireEvent.change(input, { target: { value: v } }); act(() => { vi.advanceTimersByTime(200); }); }
    expect(onCommit).not.toHaveBeenCalled(); // 200 ms after the last key
    act(() => { vi.advanceTimersByTime(AMOUNT_DEBOUNCE_MS - 200 - 1); });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('1250');
  });

  it('blur and Enter commit at once and cancel the pending timer (no second commit)', () => {
    const onCommit = vi.fn();
    render(<DebouncedAmountInput id="max" label="Max R" value="" placeholder="any" onCommit={onCommit} />);
    const input = screen.getByLabelText('Max R');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('99');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: '98' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith('98');
  });

  it('a value the parent already holds is not committed again, and a parent change (Clear) replaces the draft', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DebouncedAmountInput id="a" label="A" value="5" placeholder="" onCommit={onCommit} />);
    fireEvent.blur(screen.getByLabelText('A'));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('A'), { target: { value: '7' } });
    rerender(<DebouncedAmountInput id="a" label="A" value="" placeholder="" onCommit={onCommit} />); // Clear
    expect((screen.getByLabelText('A') as HTMLInputElement).value).toBe('');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onCommit).not.toHaveBeenCalled(); // the stale draft's timer died with it
  });

  it('unmounting cancels the timer', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<DebouncedAmountInput id="u" label="U" value="" placeholder="" onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText('U'), { target: { value: '3' } });
    unmount();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('useLlmResultPoll', () => {
  it('each tick calls the LATEST loader, not the one captured when polling began', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const first = vi.fn(async () => undefined), second = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(({ load }) => useLlmResultPoll([], load), { initialProps: { load: first } });
    act(() => { result.current.pollForLlmResults(3); });
    rerender({ load: second }); // the account/filters changed: the page hands a new loader
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('BankTxAttachmentsModal remove asks first', () => {
  const FILES = [{ id: 'a1', bank_transaction_id: 'bt-1', file_name: 'slip.png', file_url: 'data:image/png;base64,iVBORw0KGgo=', file_size: 8, uploaded_by: null, created_at: '2026-06-01' }];
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'DELETE' ? ok({ deleted: true }) : ok(FILES)));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  const deletes = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'DELETE').length;

  it('declined: the file is not removed', async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove slip.png' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('This cannot be undone'));
    expect(deletes()).toBe(0);
    expect(screen.getByText('slip.png')).toBeTruthy();
  });

  it('accepted: it is removed, once even on a double click', async () => {
    vi.stubGlobal('confirm', () => true);
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    const btn = await screen.findByRole('button', { name: 'Remove slip.png' });
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(deletes()).toBe(1));
  });
});

describe('Ask client', () => {
  const TX = { id: 'tx-1', transactionDate: '2026-06-01', description: 'WOOLWORTHS', amount: -115, status: 'imported' } as BankTx;
  vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }), useCompanyRoleOrNull: () => 'owner' }));
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      const url = String(u);
      if (init?.method === 'POST') return ok({ id: 'q1' });
      if (url.includes('settings')) return ok({ clientQueryWhatsapp: '+27821234567', companyName: 'Acme' });
      return ok([]);
    });
    Object.values(toast).forEach((f) => f.mockReset());
  });

  it('its labels are tied to their inputs (a click on the label focuses the field)', async () => {
    render(<BankTxQueryModal tx={TX} onClose={() => undefined} />);
    const phone = await screen.findByLabelText(/^WhatsApp number/);
    expect(phone.tagName).toBe('INPUT');
    expect(screen.getByLabelText(/^Message/).tagName).toBe('TEXTAREA');
  });

  it('a send toasts, tells the page, and closes', async () => {
    const onSent = vi.fn(), onClose = vi.fn();
    render(<BankTxQueryModal tx={TX} onClose={onClose} onSent={onSent} />);
    await waitFor(() => expect((screen.getByLabelText(/^WhatsApp number/) as HTMLInputElement).value).toBe('+27821234567'));
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Query sent to +27821234567');
    expect(onClose).toHaveBeenCalled();
  });

  it('a refused send toasts nothing and does not report a send', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u, init) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ success: false, error: { message: 'twilio not configured' } }), { status: 400 })
      : String(u).includes('settings') ? ok({ clientQueryWhatsapp: '+27821234567', companyName: 'Acme' }) : ok([])));
    const onSent = vi.fn();
    render(<BankTxQueryModal tx={TX} onClose={() => undefined} onSent={onSent} />);
    await waitFor(() => expect((screen.getByLabelText(/^WhatsApp number/) as HTMLInputElement).value).toBe('+27821234567'));
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await screen.findByText(/twilio not configured/);
    expect(onSent).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('the row marker', () => {
  const table = { onAccept: vi.fn(), onExclude: vi.fn(), onUnmatch: vi.fn(), onSplit: vi.fn(), onReverse: vi.fn(), onAskClient: vi.fn(), busyIds: new Set<string>() } as never;
  const base = { id: 'tx-1', transactionDate: '2026-06-01', description: 'WOOLWORTHS', amount: -115 } as BankTx;
  const show = (tx: BankTx, status = 'imported') => render(<table><tbody><tr><BankTxRowActions tx={{ ...tx, status }} label="WOOLWORTHS" sel={undefined} isNew isAllocated={false} isExcluded={false} table={table} /></tr></tbody></table>);

  it('a line with an open query has a marked Ask-client button; one without does not', () => {
    show({ ...base, queried: true });
    const marked = screen.getByRole('button', { name: /Client already asked on WhatsApp/ });
    expect(marked.getAttribute('data-queried')).toBe('true');
    cleanup();
    show(base);
    // Without a query the action is not marked: it is a plain item of the row's More actions menu (WP4b).
    expect(screen.queryByRole('button', { name: /Client already asked/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions, WOOLWORTHS' }));
    expect(screen.getByRole('menuitem', { name: 'Ask client on WhatsApp' }).getAttribute('data-queried')).toBeNull();
  });
});
