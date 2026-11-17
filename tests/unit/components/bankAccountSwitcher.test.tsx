/**
 * WP5 account switcher: cards only up to six accounts (no drag hint for one), above six up to six pinned cards plus an
 * "All accounts" combobox (search by name, number, code; ledger and "N to code"; groups with their sub-accounts;
 * keyboard only; pins in the card-order store). Cards: aria-current, one tab stop, long names keep their suffix.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankTxBankCards } from '@/components/accounting/bank-transactions/BankTxBankCards';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import type { BankAccountSummary } from '@/modules/accounting/services/bank/bankAccountSummaryService';

const apiFetch = vi.fn();
const notify = { success: vi.fn(), error: vi.fn() };
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/utils/toast', () => ({ notify: { success: (m: string) => notify.success(m), error: (m: string) => notify.error(m) } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' }, companyRole: 'owner' }) }));
vi.mock('@/components/accounting/bank-transactions/BankStatementPanel', () => ({ BankStatementPanel: () => null }));

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data, error: { message: 'refused' } }), { status });
const many = (n: number, extra: Partial<BankAccountSummary> = {}): BankAccountSummary[] => Array.from({ length: n }, (_, i) =>
  summaryAcct(`a${i + 1}`, { accountName: `Account ${i + 1}`, accountCode: String(1000 + i + 1), bankAccountNumber: `62000${String(i + 1).padStart(4, '0')}`,
    ledgerCents: (i + 1) * 10000, counts: { unallocated: i % 3 }, ...extra }));
const withPaycards = (n: number): BankAccountSummary[] => [
  ...many(3),
  ...Array.from({ length: n }, (_, i) => summaryAcct(`pc${i + 1}`, { accountName: `Employee ${i + 1} Paycard`, accountCode: `2${String(i + 1).padStart(3, '0')}`,
    bankAccountNumber: `7${String(i + 1).padStart(5, '0')}`, groupId: 'pay', groupName: 'Paycards', groupCode: '2000', ledgerCents: 500 * (i + 1) })),
];

let saved: Record<string, string> = {};
beforeEach(() => {
  saved = {}; notify.error.mockReset(); apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/preferences' && init?.method === 'PUT') return json({});
    if (url === '/api/auth/preferences') return json(saved);
    return json([]);
  });
});
afterEach(cleanup);

const ui = (accounts: BankAccountSummary[], selectedBank = accounts[0]!.id, onSelectBank = vi.fn()) => (
  <BankTxBankCards bankAccounts={accounts} selectedBank={selectedBank} shown={null} onSelectBank={onSelectBank}
    onAccountsChanged={vi.fn()} onShowProvisional={vi.fn()} />);
const cardKeys = () => screen.getAllByTestId('bank-card-slot').map(e => e.getAttribute('data-card-key'));
const puts = () => apiFetch.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT')
  .map(c => JSON.parse(JSON.parse((c[1] as RequestInit).body as string).preferences['bank_card_order:co-1'] || 'null') as string[] | null);
const open = async () => { await act(async () => { fireEvent.click(screen.getByTestId('bank-switcher-trigger')); }); return screen.getByTestId('bank-switcher-search'); };
const type = (el: HTMLElement, value: string) => act(async () => { fireEvent.change(el, { target: { value } }); });
const key = (el: HTMLElement, k: string, init: Partial<KeyboardEventInit> = {}) => act(async () => { fireEvent.keyDown(el, { key: k, ...init }); });

describe('how many accounts', () => {
  it('one account: one card, no drag hint, no switcher', () => {
    render(ui(many(1)));
    expect(cardKeys()).toEqual(['a1']);
    expect(screen.queryByText(/Drag cards to reorder/)).toBeNull();
    expect(screen.queryByTestId('bank-switcher-trigger')).toBeNull();
  });

  it('six accounts: all six cards, the drag hint, no switcher', () => {
    render(ui(many(6)));
    expect(cardKeys()).toHaveLength(6);
    expect(screen.getByText(/Drag cards to reorder/)).toBeTruthy();
    expect(screen.queryByTestId('bank-switcher-trigger')).toBeNull();
  });

  it('seven accounts: six pinned cards and the switcher, which finds the seventh', async () => {
    const onSelect = vi.fn();
    render(ui(many(7), 'a1', onSelect));
    expect(cardKeys()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    const search = await open();
    await type(search, 'Account 7');
    const opt = screen.getByTestId('bank-switcher-option');
    expect(opt.getAttribute('data-account-id')).toBe('a7');
    fireEvent.click(opt);
    expect(onSelect).toHaveBeenCalledWith('a7');
  });

  it('eighty accounts incl. a paycard group: six cards only; every account is in the list', async () => {
    const accounts = [...many(20), ...withPaycards(60).slice(3)];
    expect(accounts).toHaveLength(80);
    render(ui(accounts));
    expect(cardKeys()).toHaveLength(6);
    await open();
    expect(screen.getAllByTestId('bank-switcher-option')).toHaveLength(80);
  });
});

describe('the list', () => {
  it('searches by name, code and account number; shows ledger and "N to code"', async () => {
    render(ui(many(9)));
    const search = await open();
    await type(search, '1004');
    expect(screen.getAllByTestId('bank-switcher-option').map(o => o.getAttribute('data-account-id'))).toEqual(['a4']);
    await type(search, '620000008');
    expect(screen.getAllByTestId('bank-switcher-option').map(o => o.getAttribute('data-account-id'))).toEqual(['a8']);
    await type(search, 'account 5');
    const o = screen.getByTestId('bank-switcher-option');
    expect(within(o).getByTestId('switcher-ledger').textContent).toMatch(/500\.00/);
    expect(within(o).getByTestId('card-to-code').textContent).toMatch(/^1 to code/);
  });

  it('a paycard sub-account is found, listed under its group heading', async () => {
    render(ui(withPaycards(10), 'a1'));
    const search = await open();
    await type(search, 'employee 7');
    expect(screen.getByTestId('bank-switcher-group').textContent).toMatch(/Paycards/);
    expect(screen.getAllByTestId('bank-switcher-option').map(o => o.getAttribute('data-account-id'))).toEqual(['pc7']);
  });

  it('picking a sub-account opens its group and selects it', async () => {
    const onSelect = vi.fn();
    render(ui(withPaycards(10), 'a1', onSelect));
    const search = await open();
    await type(search, 'employee 7');
    fireEvent.click(screen.getByTestId('bank-switcher-option'));
    expect(onSelect).toHaveBeenCalledWith('pc7');
    expect(screen.getByTestId('bank-group-worklist')).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    render(ui(many(8)));
    await type(await open(), 'zzz');
    expect(screen.getByText('No account matches')).toBeTruthy();
  });
});

describe('keyboard only', () => {
  it('open, type, arrow, Enter switches the account; Escape closes', async () => {
    const onSelect = vi.fn();
    render(ui(many(30), 'a1', onSelect));
    const trigger = screen.getByTestId('bank-switcher-trigger');
    trigger.focus();
    await key(trigger, 'ArrowDown');
    const search = screen.getByTestId('bank-switcher-search');
    expect(document.activeElement).toBe(search);
    await type(search, 'account 2');
    const ids = () => screen.getAllByTestId('bank-switcher-option').map(o => o.getAttribute('data-account-id'));
    expect(ids().slice(0, 3)).toEqual(['a2', 'a20', 'a21']);
    await key(search, 'ArrowDown');
    await key(search, 'ArrowDown');
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getAllByTestId('bank-switcher-option')[2]!.id);
    await key(search, 'Enter');
    expect(onSelect).toHaveBeenCalledWith('a21');
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes without choosing', async () => {
    const onSelect = vi.fn();
    render(ui(many(8), 'a1', onSelect));
    const search = await open();
    await key(search, 'Escape');
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('pins, in the card-order store', () => {
  it('Alt+P unpins the active row, which leaves the cards; the order is saved with its boundary', async () => {
    render(ui(many(8)));
    const search = await open();
    await key(search, 'ArrowDown'); // a1 -> a2? the active row starts on a1; one step down is a2
    await key(search, 'π', { altKey: true, code: 'KeyP' }); // macOS Option+P types π; the physical key is what counts
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual(['a1', 'a3', 'a4', 'a5', 'a6', '~unpinned', 'a2', 'a7', 'a8']);
    expect(cardKeys()).toEqual(['a1', 'a3', 'a4', 'a5', 'a6']);
  });

  it('the pin button pins a card into a free slot', async () => {
    saved = { 'bank_card_order:co-1': JSON.stringify(['a1', 'a2', '~unpinned', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']) };
    render(ui(many(8)));
    await waitFor(() => expect(cardKeys()).toEqual(['a1', 'a2']));
    await open();
    const row = screen.getAllByTestId('bank-switcher-option').find(o => o.getAttribute('data-account-id') === 'a7')!;
    fireEvent.click(within(row).getByTestId('bank-switcher-pin'));
    await waitFor(() => expect(cardKeys()).toEqual(['a1', 'a2', 'a7']));
    expect(puts()[0]).toEqual(['a1', 'a2', 'a7', '~unpinned', 'a3', 'a4', 'a5', 'a6', 'a8']);
  });

  it('a seventh pin is refused with a message and nothing is saved', async () => {
    render(ui(many(8)));
    await open();
    const row = screen.getAllByTestId('bank-switcher-option').find(o => o.getAttribute('data-account-id') === 'a7')!;
    fireEvent.click(within(row).getByTestId('bank-switcher-pin'));
    expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/up to 6/));
    expect(puts()).toHaveLength(0);
    expect(cardKeys()).toHaveLength(6);
  });

  it('dragging the pinned cards keeps the unpinned ones behind the boundary', async () => {
    saved = { 'bank_card_order:co-1': JSON.stringify(['a1', 'a2', 'a3', '~unpinned', 'a4', 'a5', 'a6', 'a7']) };
    render(ui(many(7)));
    await waitFor(() => expect(cardKeys()).toEqual(['a1', 'a2', 'a3']));
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: /Account 1/ }), { key: 'ArrowRight', altKey: true }); });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual(['a2', 'a1', 'a3', '~unpinned', 'a4', 'a5', 'a6', 'a7']);
  });

  it('the control says where you are when the selected account has no card', async () => {
    saved = { 'bank_card_order:co-1': JSON.stringify(['a1', '~unpinned', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']) };
    render(ui(many(7), 'a7'));
    await waitFor(() => expect(cardKeys()).toEqual(['a1']));
    expect(screen.getByTestId('bank-switcher-trigger').getAttribute('aria-label')).toBe('All accounts, current: Account 7');
  });
});

describe('the cards', () => {
  it('aria-current marks the selected card only', () => {
    render(ui(many(4), 'a3'));
    const marked = screen.getAllByTestId('bank-account-card').filter(b => b.getAttribute('aria-current') === 'true');
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toMatch(/Account 3/);
  });

  it('one tab stop for the row: the selected card; arrows move it, Home and End jump', async () => {
    render(ui(many(5), 'a3'));
    const stops = () => screen.getAllByTestId('bank-account-card').filter(b => b.tabIndex === 0).map(b => b.textContent!.match(/Account \d/)![0]);
    expect(stops()).toEqual(['Account 3']);
    const cards = screen.getAllByTestId('bank-account-card');
    cards[2]!.focus();
    await key(cards[2]!, 'ArrowRight');
    expect(document.activeElement).toBe(cards[3]);
    expect(stops()).toEqual(['Account 4']);
    await key(cards[3]!, 'End');
    expect(stops()).toEqual(['Account 5']);
    await key(cards[4]!, 'Home');
    expect(stops()).toEqual(['Account 1']);
  });

  it('a long name keeps its distinguishing suffix visible', () => {
    const long = 'First National Bank Business Current Account ****4567';
    render(ui([summaryAcct('x', { accountName: long }), ...many(1)]));
    const name = screen.getAllByTestId('card-name')[0]!;
    expect(name.getAttribute('title')).toBe(long);
    const parts = name.querySelectorAll('span');
    expect(parts).toHaveLength(2);
    expect(parts[1]!.className).toMatch(/shrink-0/);
    expect(parts[1]!.textContent!.endsWith('****4567')).toBe(true);
  });
});

describe('review round 1', () => {
  it('Tab out of the control closes the popup and clears the search; focus is left where Tab put it', async () => {
    render(<div><button data-testid="after">after</button>{ui(many(8))}</div>);
    const search = await open();
    await type(search, 'account 3');
    const after = screen.getByTestId('after');
    await act(async () => { fireEvent.blur(search, { relatedTarget: after }); });
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
    await open();
    expect((screen.getByTestId('bank-switcher-search') as HTMLInputElement).value).toBe('');
  });

  it('focus leaving to the browser chrome (relatedTarget null) closes it too', async () => {
    render(ui(many(8)));
    const search = await open();
    await act(async () => { fireEvent.blur(search, { relatedTarget: null }); });
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
  });

  it('a press inside the popup keeps focus in the search box, so the blur-close cannot eat the click', async () => {
    render(ui(many(8)));
    await open();
    const notPrevented = fireEvent.mouseDown(screen.getAllByTestId('bank-switcher-option')[0]!);
    expect(notPrevented).toBe(false); // default prevented
  });

  it('Safari order: pressing the trigger blurs the search box with no relatedTarget, then the click must leave it closed', async () => {
    render(ui(many(8)));
    const search = await open();
    const trigger = screen.getByTestId('bank-switcher-trigger');
    // One act per event: each browser event is its own task, and the click must see the blur's state change.
    await act(async () => { fireEvent.mouseDown(trigger); });
    await act(async () => { fireEvent.blur(search, { relatedTarget: null }); }); // the button took no focus
    await act(async () => { fireEvent.mouseUp(trigger); });
    await act(async () => { fireEvent.click(trigger); });
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
  });

  const mouseOpen = async () => {
    const trigger = screen.getByTestId('bank-switcher-trigger');
    await act(async () => { fireEvent.mouseDown(trigger); });
    await act(async () => { fireEvent.mouseUp(trigger); });
    await act(async () => { fireEvent.click(trigger); });
    return screen.getByTestId('bank-switcher-search');
  };

  it('opened with the mouse, a later blur to nowhere (Tab to the browser chrome) still closes it', async () => {
    render(ui(many(8)));
    const search = await mouseOpen();
    await act(async () => { fireEvent.blur(search, { relatedTarget: null }); });
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
  });

  it('press the trigger, Escape, reopen by keyboard: Tab out still closes it', async () => {
    render(ui(many(8)));
    const trigger = screen.getByTestId('bank-switcher-trigger');
    await act(async () => { fireEvent.mouseDown(trigger); });
    await act(async () => { fireEvent.click(trigger); }); // no mouseup reached the page (released elsewhere)
    await key(screen.getByTestId('bank-switcher-search'), 'Escape');
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
    await key(trigger, 'ArrowDown');
    const search = screen.getByTestId('bank-switcher-search');
    await act(async () => { fireEvent.blur(search, { relatedTarget: null }); });
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
  });

  it('a press on the search box keeps its default (caret, selection); a press elsewhere in the popup does not', async () => {
    render(ui(many(8)));
    const search = await open();
    expect(fireEvent.mouseDown(search)).toBe(true);
    expect(fireEvent.mouseDown(screen.getAllByTestId('bank-switcher-option')[0]!)).toBe(false);
  });

  it('focus moving to the trigger itself (Shift+Tab) does not close it', async () => {
    render(ui(many(8)));
    const search = await open();
    await act(async () => { fireEvent.blur(search, { relatedTarget: screen.getByTestId('bank-switcher-trigger') }); });
    expect(screen.getByTestId('bank-switcher-search')).toBeTruthy();
  });

  it('clicking the trigger while open closes it, clears the query and returns focus to it', async () => {
    render(ui(many(8)));
    const search = await open();
    await type(search, 'account 3');
    const trigger = screen.getByTestId('bank-switcher-trigger');
    await act(async () => { fireEvent.click(trigger); });
    expect(screen.queryByTestId('bank-switcher-search')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect((await open() as HTMLInputElement).value).toBe('');
  });

  it('unpinning the last pin is refused with a message; the row keeps its card', async () => {
    saved = { 'bank_card_order:co-1': JSON.stringify(['a1', '~unpinned', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']) };
    render(ui(many(7)));
    await waitFor(() => expect(cardKeys()).toEqual(['a1']));
    const search = await open();
    await key(search, 'p', { altKey: true, code: 'KeyP' });
    expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/at least one/));
    expect(puts()).toHaveLength(0);
    expect(cardKeys()).toEqual(['a1']);
  });

  it('a sub-account group is a role=group with a label wrapping its options', async () => {
    render(ui(withPaycards(5), 'a1'));
    await open();
    const group = screen.getByRole('group', { name: /Paycards, 5 sub-accounts/ });
    expect(within(group).getAllByTestId('bank-switcher-option')).toHaveLength(5);
  });

  it('after a pick from the switcher the tab stop is the selected card', async () => {
    const Harness = () => {
      const [sel, setSel] = useState('a1');
      return ui(many(8), sel, setSel);
    };
    render(<Harness />);
    const stops = () => screen.getAllByTestId('bank-account-card').filter(b => b.tabIndex === 0).map(b => b.textContent!.match(/Account \d/)![0]);
    const cards = screen.getAllByTestId('bank-account-card');
    await act(async () => { fireEvent.focus(cards[3]!); }); // the row's tab stop moves to Account 4 with focus
    expect(stops()).toEqual(['Account 4']);
    const search = await open();
    await type(search, 'account 2');
    fireEvent.click(screen.getByTestId('bank-switcher-option'));
    expect(stops()).toEqual(['Account 2']);
  });
});
