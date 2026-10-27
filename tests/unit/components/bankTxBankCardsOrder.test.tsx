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
let company = 'co-1';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: company }, companyRole: 'owner' }) }));
vi.mock('@/components/accounting/StatementBalanceWidget', () => ({ StatementBalanceWidget: () => null }));
// The row's real DndContext, with its onDragEnd captured so a test can drop a card without pointer geometry.
let dragEnd: ((e: { active: { id: string }; over: { id: string } | null }) => void) | null = null;
vi.mock('@dnd-kit/core', async (orig) => {
  const real = await orig<typeof import('@dnd-kit/core')>();
  const { createElement } = await import('react');
  return { ...real, DndContext: (props: Parameters<typeof real.DndContext>[0]) => {
    dragEnd = props.onDragEnd as typeof dragEnd;
    return createElement(real.DndContext, props);
  } };
});

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
  saved = {}; putStatus = 200; company = 'co-1'; notify.error.mockReset(); apiFetch.mockReset();
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
const ui = (onSelectBank = vi.fn(), list = accounts) => (
  <BankTxBankCards bankAccounts={list} selectedBank="p1" tab="new" total={0} onSelectBank={onSelectBank} onAccountsChanged={vi.fn()} />);
const view = () => {
  const onSelectBank = vi.fn();
  const r = render(ui(onSelectBank));
  return { onSelectBank, rerender: r.rerender };
};
const altRight = (name: RegExp) => act(async () => {
  fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'ArrowRight', altKey: true });
});

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

it('the keyboard move keeps focus on the moved card and announces its new place', async () => {
  view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  screen.getByRole('button', { name: /Main/ }).focus();
  await altRight(/Main/);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Main/ })));
  expect(screen.getByTestId('bank-cards-announcement').textContent).toBe('Main moved to position 2 of 3');
});

it('a saved place for a card not on screen is kept when the others are reordered', async () => {
  saved = { 'bank_card_order:co-1': JSON.stringify(['gone-later', 'p1', 'p2']) };
  view();
  await waitFor(() => expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']));
  await altRight(/Main/);
  expect(puts()).toEqual([JSON.stringify(['p2', 'p1', 'group:g1', 'gone-later'])]);
});

it('saves are sent one at a time: the second waits for the first, and a failed first does not undo the second', async () => {
  let releaseFirst!: () => void;
  const first = new Promise<void>((r) => { releaseFirst = r; });
  let n = 0;
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/preferences' && init?.method === 'PUT') {
      n += 1;
      if (n === 1) { await first; return json({}, 500); }
      return json({});
    }
    return json(url === '/api/auth/preferences' ? {} : []);
  });
  view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await altRight(/Main/);
  await altRight(/Main/);
  expect(slotKeys()).toEqual(['p2', 'group:g1', 'p1']);
  expect(puts()).toHaveLength(1);
  await act(async () => { releaseFirst(); await first; });
  await waitFor(() => expect(puts()).toHaveLength(2));
  await new Promise((r) => setTimeout(r, 20));
  expect(slotKeys()).toEqual(['p2', 'group:g1', 'p1']);
  expect(notify.error).not.toHaveBeenCalled();
});

it('a save refused after switching company does not put the old company\'s order on the new one', async () => {
  let releasePut!: () => void;
  const put = new Promise<void>((r) => { releasePut = r; });
  let n = 0;
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/preferences' && init?.method === 'PUT') {
      n += 1;
      if (n === 1) { await put; return json({}, 500); }
      return json({});
    }
    return json(url === '/api/auth/preferences' ? {} : []);
  });
  const { rerender } = view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await altRight(/Main/);
  company = 'co-2';
  rerender(ui());
  await waitFor(() => expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']));
  // The first save in the new company, made while the old company's save is still pending.
  await altRight(/Savings/);
  expect(slotKeys()).toEqual(['p1', 'group:g1', 'p2']);
  await act(async () => { releasePut(); await put; });
  await new Promise((r) => setTimeout(r, 20));
  expect(slotKeys()).toEqual(['p1', 'group:g1', 'p2']);
  expect(notify.error).not.toHaveBeenCalled();
});

it('two moves in one batch both keep the saved place of a card not on screen', async () => {
  saved = { 'bank_card_order:co-1': JSON.stringify(['gone-later', 'p1', 'p2']) };
  view();
  await waitFor(() => expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']));
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('button', { name: /Main/ }), { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(screen.getByRole('button', { name: /Main/ }), { key: 'ArrowRight', altKey: true });
  });
  await waitFor(() => expect(puts()).toHaveLength(2));
  expect(puts().every(p => JSON.parse(p).includes('gone-later'))).toBe(true);
});

it('when every save fails the cards go back to the order the server last confirmed', async () => {
  saved = { 'bank_card_order:co-1': JSON.stringify(['p2', 'p1']) };
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/preferences' && init?.method === 'PUT') { await hold; return json({}, 500); }
    return json(url === '/api/auth/preferences' ? saved : []);
  });
  view();
  await waitFor(() => expect(slotKeys()).toEqual(['p2', 'p1', 'group:g1']));
  // Both moves are made before either save is answered; both are then refused.
  await altRight(/Savings/);
  await altRight(/Savings/);
  expect(slotKeys()).toEqual(['p1', 'group:g1', 'p2']);
  await act(async () => { release(); await hold; });
  await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
  expect(slotKeys()).toEqual(['p2', 'p1', 'group:g1']);
});

it('a drop moves the card into the target\'s place, and the click it ends with does not select it', async () => {
  const { onSelectBank } = view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(1_000_000);
  await act(async () => { dragEnd!({ active: { id: 'p1' }, over: { id: 'group:g1' } }); });
  expect(slotKeys()).toEqual(['p2', 'group:g1', 'p1']);
  expect(puts()).toEqual([JSON.stringify(['p2', 'group:g1', 'p1'])]);
  fireEvent.click(screen.getByRole('button', { name: /Main/ }));
  expect(onSelectBank).not.toHaveBeenCalled();
  now.mockReturnValue(1_000_000 + 400);
  fireEvent.click(screen.getByRole('button', { name: /Main/ }));
  expect(onSelectBank).toHaveBeenCalledWith('p1');
  now.mockRestore();
});

it('a drop on nothing, or on itself, changes nothing', async () => {
  view();
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await act(async () => { dragEnd!({ active: { id: 'p1' }, over: null }); dragEnd!({ active: { id: 'p1' }, over: { id: 'p1' } }); });
  expect(slotKeys()).toEqual(['p1', 'p2', 'group:g1']);
  expect(puts()).toEqual([]);
});
