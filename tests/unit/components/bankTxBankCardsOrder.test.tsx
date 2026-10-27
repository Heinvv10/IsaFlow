/**
 * BankTxBankCards — the card row in the user's own order (user_preferences,
 * per company), reorderable from the keyboard, and choosing a primary account
 * closes an open group so the group card no longer reads as selected.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BankTxBankCards, type BankAcct } from '@/components/accounting/bank-transactions/BankTxBankCards';

const apiFetch = vi.fn();
const notify = { success: vi.fn(), error: vi.fn() };
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/utils/toast', () => ({ notify: { success: (m: string) => notify.success(m), error: (m: string) => notify.error(m) } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' }, companyRole: 'owner' }) }));
vi.mock('@/components/accounting/StatementBalanceWidget', () => ({ StatementBalanceWidget: () => null }));

const acct = (id: string, name: string, group?: string): BankAcct => ({
  id, accountCode: id, accountName: name, balance: 0, reconciledBalance: 0, unreconciledBalance: 0,
  unreconciledCount: 0, allocatedCount: 0, unallocatedCount: 0, lastDate: '2026-10-20',
  ...(group ? { groupId: group, groupName: `Group ${group}` } : {}),
});
const accounts = [acct('p1', 'Main'), acct('p2', 'Savings'), acct('c1', 'Card 1', 'g1'), acct('c2', 'Card 2', 'g1')];
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data, error: { message: 'refused' } }), { status });

let saved: Record<string, string> = {};
let putStatus = 200;
beforeEach(() => {
  saved = {}; putStatus = 200; notify.error.mockReset(); apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/preferences' && init?.method === 'PUT') return json({}, putStatus);
    if (url === '/api/auth/preferences') return json(saved);
    return json([]);
  });
});
afterEach(() => { cleanup(); });

const slotKeys = () => screen.getAllByTestId('bank-card-slot').map(e => e.getAttribute('data-card-key'));
const puts = () => apiFetch.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT')
  .map(c => JSON.parse((c[1] as RequestInit).body as string).preferences['bank_card_order:co-1'] as string);
const view = (selectedBank = 'p1') => {
  const onSelectBank = vi.fn();
  render(<BankTxBankCards bankAccounts={accounts} selectedBank={selectedBank} tab="new" total={0}
    onSelectBank={onSelectBank} onAccountsChanged={vi.fn()} />);
  return { onSelectBank };
};

it('choosing a primary account closes the open group: its card is no longer expanded or selected', async () => {
  const { onSelectBank } = view();
  const groupToggle = screen.getByRole('button', { name: /Group g1/ });
  fireEvent.click(groupToggle);
  expect(screen.getByTestId('bank-group-worklist')).toBeTruthy();
  expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /Savings/ }));
  expect(onSelectBank).toHaveBeenCalledWith('p2');
  expect(screen.queryByTestId('bank-group-worklist')).toBeNull();
  expect(groupToggle.getAttribute('aria-expanded')).toBe('false');
});

it('without a saved order: primaries then groups, as before', async () => {
  view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/auth/preferences'));
  expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']);
  expect(screen.queryByTestId('bank-cards-reset-order')).toBeNull();
});

it('a saved order for this company is applied', async () => {
  saved = { 'bank_card_order:co-1': JSON.stringify(['group:g1', 'p2']), 'bank_card_order:other': '["p1"]' };
  view();
  await waitFor(() => expect(slotKeys()).toEqual(['group:g1', 'p2', 'p1']));
  expect(screen.getByTestId('bank-cards-reset-order')).toBeTruthy();
});

it('Alt+ArrowRight moves the focused card one place and saves the order', async () => {
  view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: /Main/ }), { key: 'ArrowRight', altKey: true }); });
  expect(slotKeys()).toEqual(['p2', 'p1', 'group:g1']);
  expect(puts()).toEqual([JSON.stringify(['p2', 'p1', 'group:g1'])]);
});

it('ArrowRight without Alt moves nothing', async () => {
  view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  fireEvent.keyDown(screen.getByRole('button', { name: /Main/ }), { key: 'ArrowRight' });
  expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']);
  expect(puts()).toEqual([]);
});

it('Reset order clears the saved order', async () => {
  saved = { 'bank_card_order:co-1': JSON.stringify(['group:g1']) };
  view();
  await waitFor(() => expect(slotKeys()[0]).toBe('group:g1'));
  await act(async () => { fireEvent.click(screen.getByTestId('bank-cards-reset-order')); });
  expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']);
  expect(puts()).toEqual(['']);
});

it('a refused save puts the cards back and says so', async () => {
  putStatus = 500;
  view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: /Main/ }), { key: 'ArrowRight', altKey: true }); });
  await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
  expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']);
});

it('a reorder made before the saved order has loaded is not overwritten when it arrives', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/preferences' && init?.method === 'PUT') return json({});
    if (url === '/api/auth/preferences') { await gate; return json({}); }
    return json([]);
  });
  view();
  await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: /Main/ }), { key: 'ArrowRight', altKey: true }); });
  expect(slotKeys()).toEqual(['p2', 'p1', 'group:g1']);
  await act(async () => { release(); await gate; });
  await new Promise((r) => setTimeout(r, 20));
  expect(slotKeys()).toEqual(['p2', 'p1', 'group:g1']);
});
