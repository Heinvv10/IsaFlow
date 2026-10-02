/**
 * W1-02 LOW: four pages swallowed a failed reference-data fetch in an empty
 * catch, leaving a dead selector / stuck "Loading…" and no explanation.
 * Real apiFetch/apiJson run; only the network (global fetch) is stubbed.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ImportPdfPage from '@/../pages/accounting/bank/statements/import-pdf';
import CashbookPage from '@/../pages/accounting/cashbook';
import CaptureInboxPage from '@/../pages/accounting/capture/inbox';
import NewBankTransactionPage from '@/../pages/accounting/bank-transactions/new';

const notifyError = vi.fn();
vi.mock('@/utils/toast', () => ({ notify: { error: (m: string) => notifyError(m), success: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const fail = () => new Response(JSON.stringify({ success: false, message: 'boom' }), { status: 500 });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

beforeEach(() => { notifyError.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('import-pdf: a failed bank-account load says so and stops saying "Loading accounts…"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => fail()));
  render(<ImportPdfPage />);
  expect(await screen.findByText(/could not load bank accounts/i)).toBeInTheDocument();
  expect(screen.queryByText(/Loading accounts/)).toBeNull();
});

it('cashbook: a failed bank-account load shows an error and stops the spinner', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => fail()));
  render(<CashbookPage />);
  expect(await screen.findByText(/boom/)).toBeInTheDocument();
  expect(screen.getByText(/No transactions for selected period/)).toBeInTheDocument();
});

it('capture inbox: a failed inbox-address load is reported', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).includes('inbox-address') ? fail() : ok({ events: [] })));
  render(<CaptureInboxPage />);
  expect(await screen.findByText(/boom/)).toBeInTheDocument();
});

it('new bank transaction: a failed bank-account load is reported', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).includes('bank-accounts') ? fail() : ok([])));
  render(<NewBankTransactionPage />);
  await waitFor(() => expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/bank accounts/i)));
});
