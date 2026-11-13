// M14: `?line=<id>` on the bank page (a comment mention's link) reads that one line; clear drops the parameter.
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const replace = vi.fn(async () => true);
let query: Record<string, string> = {};
let ready = true;
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: ready, query, pathname: '/accounting/bank-transactions', replace }) }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { useBankLineDeepLink } from '@/components/accounting/bank-transactions/useBankLineDeepLink';

const closeList = vi.fn();
function Probe({ listTx }: { listTx?: { id: string } }) {
  const { detailTx, error, closeDetail, dismissError } = useBankLineDeepLink(listTx as never, closeList);
  return <div><span data-testid="line">{detailTx?.id ?? ''}</span><span data-testid="err">{error}</span>
    <button onClick={closeDetail}>clear</button><button onClick={dismissError}>dismiss</button></div>;
}
beforeEach(() => { replace.mockClear(); closeList.mockClear(); ready = true; query = { account_id: 'a1', line: 'tx-5' }; });
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

it('reads the named line and hands it over; clear drops only `line` from the URL', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'tx-5' } }), { status: 200 }));
  render(<Probe />);
  await vi.waitFor(() => expect(screen.getByTestId('line').textContent).toBe('tx-5'));
  expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('/api/accounting/bank-transaction-line?id=tx-5');
  fireEvent.click(screen.getByText('clear'));
  expect(replace).toHaveBeenCalledWith({ pathname: '/accounting/bank-transactions', query: { account_id: 'a1' } }, undefined, { shallow: true });
  expect(screen.getByTestId('line').textContent).toBe('');
});

it('a stale link (404): says so, opens nothing, drops ?line, and the notice can be dismissed', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: 'Bank line not found' } }), { status: 404 }));
  render(<Probe />);
  await vi.waitFor(() => expect(screen.getByTestId('err').textContent).toBe('Bank line not found'));
  expect(screen.getByTestId('line').textContent).toBe('');
  expect(replace).toHaveBeenCalledWith({ pathname: '/accounting/bank-transactions', query: { account_id: 'a1' } }, undefined, { shallow: true });
  fireEvent.click(screen.getByText('dismiss'));
  expect(screen.getByTestId('err').textContent).toBe('');
});

it('the list\'s own line wins over the linked one, and close closes the list drawer too', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'tx-5' } }), { status: 200 }));
  render(<Probe listTx={{ id: 'tx-list' }} />);
  expect(screen.getByTestId('line').textContent).toBe('tx-list');
  fireEvent.click(screen.getByText('clear'));
  expect(closeList).toHaveBeenCalledTimes(1);
});

it('router not ready: nothing is fetched yet', () => {
  ready = false;
  render(<Probe />);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('without ?line= nothing is fetched', () => {
  query = { account_id: 'a1' };
  render(<Probe />);
  expect(apiFetch).not.toHaveBeenCalled();
});
