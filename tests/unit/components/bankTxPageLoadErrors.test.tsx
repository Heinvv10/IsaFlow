/**
 * The real bank transactions page, with only the network scripted.
 * (1) A failed load on page 3 must show the error on page 3: the failure path empties the rows and the total,
 *     which usePageClamp and BankTxListFrame used to read as "past the end" (a skeleton, then a silent jump to page 1).
 * (2) loadTransactions has no request sequencing of its own: a slow older response must not overwrite a newer one.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BankTx } from '@/components/accounting/bankTx/bankTxTypes';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import BankTransactionsPage from '@/../pages/accounting/bank-transactions/index';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/accounting/bank-transactions' }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer' }) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const BANK = { id: 'b1', accountCode: '1000', accountName: 'Main', balance: 0, reconciledBalance: 0, unreconciledBalance: 0, unreconciledCount: 60, allocatedCount: 0, unallocatedCount: 60 };
const row = (id: string): BankTx => ({ id, description: id, amount: -10, transactionDate: '2026-06-01', status: 'imported' });
const txPage = (...ids: string[]) => json({ success: true, data: { transactions: ids.map(row), total: 60 } });

const txCalls = () => vi.mocked(apiFetch).mock.calls
  .map(([url]) => String(url)).filter(u => u.startsWith('/api/accounting/bank-transactions?'));
const offsets = () => txCalls().map(u => new URL(u, 'http://x').searchParams.get('offset'));

/** Answers everything except the transaction list with empty data; `list` answers the list. */
function script(list: (offset: string) => Promise<Response> | Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/bank-transactions?')) return list(new URL(path, 'http://x').searchParams.get('offset') ?? '0');
    if (path.startsWith('/api/accounting/bank-accounts')) return json({ success: true, data: [BANK] });
    return json({ success: true, data: [] });
  });
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

it('a failed load on page 3 shows the error on page 3: no skeleton, no jump back to page 1', async () => {
  script(offset => (offset === '50' ? json({ success: false, message: 'db down' }, 500) : txPage('ROW-P1')));
  render(<BankTransactionsPage />);
  await screen.findByText('ROW-P1');

  fireEvent.click(screen.getByRole('button', { name: '3' }));

  expect(await screen.findByText(/could not load|db down/i)).toBeInTheDocument();
  expect(screen.queryByTestId('list-skeleton')).toBeNull();
  await new Promise(r => setTimeout(r, 100)); // a clamp would refetch page 1 within a tick
  expect(offsets()).toEqual(['0', '50']);
  expect(screen.queryByTestId('list-skeleton')).toBeNull();
});

it('a slow older response does not overwrite a newer one', async () => {
  let releasePage2: (r: Response) => void = () => {};
  const page2 = new Promise<Response>(res => { releasePage2 = res; });
  script(offset => (offset === '25' ? page2 : offset === '50' ? txPage('ROW-P3') : txPage('ROW-P1')));
  render(<BankTransactionsPage />);
  await screen.findByText('ROW-P1');

  fireEvent.click(screen.getByRole('button', { name: '2' })); // request A: held
  fireEvent.click(screen.getByRole('button', { name: '3' })); // request B: answers at once
  await screen.findByText('ROW-P3');

  releasePage2(txPage('ROW-P2')); // A arrives late
  await new Promise(r => setTimeout(r, 100));
  await waitFor(() => expect(screen.getByText('ROW-P3')).toBeInTheDocument());
  expect(screen.queryByText('ROW-P2')).toBeNull();
});

it('an older response arriving while a newer request is pending does not end the loading state', async () => {
  let releasePage2: (r: Response) => void = () => {};
  let releasePage3: (r: Response) => void = () => {};
  const page2 = new Promise<Response>(res => { releasePage2 = res; });
  const page3 = new Promise<Response>(res => { releasePage3 = res; });
  script(offset => (offset === '25' ? page2 : offset === '50' ? page3 : txPage('ROW-P1')));
  render(<BankTransactionsPage />);
  await screen.findByText('ROW-P1');

  fireEvent.click(screen.getByRole('button', { name: '2' }));
  fireEvent.click(screen.getByRole('button', { name: '3' }));
  releasePage2(txPage('ROW-P2')); // A settles first; B is still in flight
  await new Promise(r => setTimeout(r, 100));
  expect(screen.getByTestId('list-skeleton')).toBeInTheDocument();
  expect(screen.queryByText('ROW-P2')).toBeNull();

  releasePage3(txPage('ROW-P3'));
  expect(await screen.findByText('ROW-P3')).toBeInTheDocument();
});

/** Every element ever added to `root`, whether or not it was gone again by the time anything looked. */
function watchAdded(root: HTMLElement, testId: string): { seen: () => boolean; stop: () => void } {
  let seen = false;
  const hit = (n: Node) => n instanceof HTMLElement && (n.dataset.testid === testId || n.querySelector(`[data-testid="${testId}"]`) !== null);
  const mo = new MutationObserver((records) => { for (const r of records) r.addedNodes.forEach((n) => { if (hit(n)) seen = true; }); });
  mo.observe(root, { childList: true, subtree: true });
  return { seen: () => { mo.takeRecords().forEach((r) => r.addedNodes.forEach((n) => { if (hit(n)) seen = true; })); return seen; }, stop: () => mo.disconnect() };
}

it('a reload past the end never paints "No new transactions": the skeleton holds until the clamped page arrives', async () => {
  // page 3 of 60 rows; the next load says there are only 50, so page 3 no longer exists and the clamp moves to page 2
  const total = 60;
  script(offset => {
    if (offset === '50') return json({ success: true, data: { transactions: [], total: 50 } });
    if (offset === '25') return json({ success: true, data: { transactions: [row('ROW-P2')], total: 50 } });
    return json({ success: true, data: { transactions: [row('ROW-P1')], total } });
  });
  const { container } = render(<BankTransactionsPage />);
  await screen.findByText('ROW-P1');

  const empty = watchAdded(container, 'bank-tx-empty');
  fireEvent.click(screen.getByRole('button', { name: '3' }));
  expect(await screen.findByText('ROW-P2')).toBeInTheDocument();

  expect(offsets()).toEqual(['0', '50', '25']);
  expect(empty.seen()).toBe(false);
  empty.stop();
});
