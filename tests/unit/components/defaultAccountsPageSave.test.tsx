/**
 * W2-28 round 3: the Default Accounts page posted its WHOLE loaded map, so a
 * tab loaded before another user moved the primary bank put the bank back when
 * it saved an unrelated change. It must send only the rows the user changed,
 * with the holder it loaded for each (`loaded`), and on 409 reload and say why.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DefaultAccountsPage from '@/../pages/accounting/default-accounts';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const ACCOUNTS = [
  { id: 'bank-1', accountCode: '1110', accountName: 'Bank' },
  { id: 'ar-1', accountCode: '1120', accountName: 'AR' },
  { id: 'ar-2', accountCode: '1121', accountName: 'AR new' },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function answer(postStatus = 200) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/chart-of-accounts')) return json({ data: ACCOUNTS });
    if (init?.method === 'POST') {
      return postStatus === 409
        ? json({ success: false, error: { code: 'CONFLICT', message: 'Default accounts changed since you loaded this page.' } }, 409)
        : json({ success: true, data: { saved: true } });
    }
    return json({ data: { mappings: { primary_bank: 'bank-1', accounts_receivable: 'ar-1' } } });
  });
}

const posted = () => {
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST');
  return JSON.parse(String(call?.[1]?.body));
};
const mappingLoads = () => vi.mocked(apiFetch).mock.calls
  .filter(([url, init]) => String(url) === '/api/accounting/default-accounts' && init?.method !== 'POST').length;

afterEach(() => { cleanup(); });

it('sends only the changed row, with the holder it loaded for that row', async () => {
  answer();
  render(<DefaultAccountsPage />);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Accounts Receivable' }), { target: { value: 'ar-2' } });
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
  await waitFor(() => expect(posted()).toEqual({
    mappings: { accounts_receivable: 'ar-2' },
    loaded: { accounts_receivable: 'ar-1' },
  }));
});

it('on 409 reloads the mappings and shows the server\'s message', async () => {
  answer(409);
  render(<DefaultAccountsPage />);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Accounts Receivable' }), { target: { value: 'ar-2' } });
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
  expect(await screen.findByText(/changed since you loaded this page/)).toBeTruthy();
  expect(mappingLoads()).toBe(2);
});

it('when the reload after a save fails, says so instead of leaving "saved" over rows it could not refresh', async () => {
  answer();
  render(<DefaultAccountsPage />);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Accounts Receivable' }), { target: { value: 'ar-2' } });
  const answered = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method !== 'POST' && mappingLoads() > 1) throw new Error('network'); // the reload, not the first load
    return answered(url, init);
  });
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
  expect(await screen.findByText('Failed to load configuration')).toBeTruthy();
  expect(screen.queryByText('Default accounts saved')).toBeNull();
});
