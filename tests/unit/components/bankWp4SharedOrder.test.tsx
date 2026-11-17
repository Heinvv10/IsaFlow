/**
 * WP4a: the page and the cards share ONE read of the saved card order (the page needs it to pick the default account, the
 * cards to lay themselves out): `useBankCardOrder` says when it has loaded (or failed), and BankTxBankCards takes the
 * page's source instead of reading the preferences a second time. Alone it still loads its own.
 */
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankTxBankCards } from '@/components/accounting/bank-transactions/BankTxBankCards';
import { useBankCardOrder } from '@/components/accounting/bank-transactions/useBankCardOrder';
import { summaryAcct } from '../helpers/bankSummaryFixture';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' }, companyRole: 'owner' }) }));
vi.mock('@/components/accounting/bank-transactions/BankStatementPanel', () => ({ BankStatementPanel: () => null }));

const accounts = [summaryAcct('p1', { accountName: 'Main' }), summaryAcct('p2', { accountName: 'Savings' })];
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
const prefReads = () => apiFetch.mock.calls.filter(c => c[0] === '/api/auth/preferences' && !(c[1] as RequestInit | undefined)?.method).length;
const slotKeys = () => screen.getAllByTestId('bank-card-slot').map(e => e.getAttribute('data-card-key'));

let saved: Record<string, string> = {}, fail = false;
beforeEach(() => {
  saved = { 'bank_card_order:co-1': JSON.stringify(['p2', 'p1']) }; fail = false; apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => (url === '/api/auth/preferences' ? (fail ? json({}, 500) : json(saved)) : json([])));
});
afterEach(cleanup);

function PageAndCards({ shared }: { shared: boolean }) {
  const order = useBankCardOrder('co-1');
  return <BankTxBankCards bankAccounts={accounts} selectedBank="p1" shown={null} onSelectBank={vi.fn()} onAccountsChanged={vi.fn()} onShowProvisional={vi.fn()}
    cardOrder={shared ? order : undefined} />;
}

describe('useBankCardOrder reports when the order has been read', () => {
  it('false until the preferences answer, then true, with the order', async () => {
    const { result } = renderHook(() => useBankCardOrder('co-1'));
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.order).toEqual(['p2', 'p1']);
  });
  it('true when the read FAILED too (the default order stands), with no order', async () => {
    fail = true;
    const { result } = renderHook(() => useBankCardOrder('co-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.order).toBeNull();
  });
  it('with no company there is nothing to read and nothing loaded', async () => {
    const { result } = renderHook(() => useBankCardOrder(undefined));
    await new Promise(r => setTimeout(r, 5));
    expect(result.current.loaded).toBe(false); expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('the cards take the page\'s order source', () => {
  it('SHARED: the preferences are read once for the page AND the cards, and the cards show the saved order', async () => {
    render(<PageAndCards shared />);
    await waitFor(() => expect(slotKeys()).toEqual(['p2', 'p1']));
    expect(prefReads()).toBe(1);
  });
  it('ALONE (no source passed): the cards still load their own order', async () => {
    render(<BankTxBankCards bankAccounts={accounts} selectedBank="p1" shown={null} onSelectBank={vi.fn()} onAccountsChanged={vi.fn()} onShowProvisional={vi.fn()} />);
    await waitFor(() => expect(slotKeys()).toEqual(['p2', 'p1']));
    expect(prefReads()).toBe(1);
  });
  it('...whereas a page that does NOT hand its source over reads twice (page + cards): the duplicate sharing removes', async () => {
    render(<PageAndCards shared={false} />);
    await waitFor(() => expect(slotKeys()).toEqual(['p2', 'p1']));
    expect(prefReads()).toBe(2);
  });
});
