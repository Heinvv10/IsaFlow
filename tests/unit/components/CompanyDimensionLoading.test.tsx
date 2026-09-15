import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CompanySettingsPage from '../../../pages/accounting/company-settings';
import { apiFetch } from '@/lib/apiFetch';

const context = vi.hoisted(() => ({ activeCompany: { id: 'company-a' }, loading: false }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => context }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { tab: 'dimensions' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

const ccKey = 'enable_cost_centres';
const buKey = 'enable_business_units';
function setting(key: string, value: string | null) {
  return Response.json({ success: true, data: { key, value } });
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
let dimensionRead: (key: string) => Promise<Response>;
beforeEach(() => {
  context.activeCompany = { id: 'company-a' };
  dimensionRead = async key => setting(key, 'true');
  vi.mocked(apiFetch).mockImplementation(async url => {
    const key = new URL(url, 'https://example.test').searchParams.get('key');
    if (key === ccKey || key === buKey) return dimensionRead(key);
    if (url.startsWith('/api/accounting/companies?')) {
      return Response.json({ success: true, data: { id: context.activeCompany.id, name: 'Example Company' } });
    }
    return Response.json({ success: true, data: [] });
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each([ccKey, buKey])('shows a retryable load error instead of off when %s returns HTTP 500', async failedKey => {
  dimensionRead = async key => key === failedKey
    ? Response.json({ success: false, message: 'Unavailable' }, { status: 500 })
    : setting(key, 'true');
  render(<CompanySettingsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not load.*dimension/i);
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  dimensionRead = async key => setting(key, 'true');
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2));
  for (const toggle of screen.getAllByRole('switch')) expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('handles a rejected dimension request as unavailable', async () => {
  dimensionRead = async () => { throw new TypeError('Network unavailable'); };
  render(<CompanySettingsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not load.*dimension/i);
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
});

it.each([{}, { success: true, data: { key: ccKey, value: 'unexpected' } }])('rejects malformed successful dimension responses: %j', async body => {
  dimensionRead = async () => Response.json(body);
  render(<CompanySettingsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not load.*dimension/i);
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
});

it('treats a confirmed missing setting as off', async () => {
  dimensionRead = async key => setting(key, null);
  render(<CompanySettingsPage />);
  await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2));
  for (const toggle of screen.getAllByRole('switch')) expect(toggle).toHaveAttribute('aria-checked', 'false');
});

it('hides previous company switches while the next company loads', async () => {
  const view = render(<CompanySettingsPage />);
  await screen.findAllByRole('switch');
  const pending = deferred();
  dimensionRead = () => pending.promise;
  context.activeCompany = { id: 'company-b' };
  view.rerender(<CompanySettingsPage />);
  await screen.findByText('Reporting Dimensions');
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
});

it('ignores late dimension responses from the previous company', async () => {
  const oldCC = deferred();
  const oldBU = deferred();
  dimensionRead = key => key === ccKey ? oldCC.promise : oldBU.promise;
  const view = render(<CompanySettingsPage />);
  await screen.findByText('Reporting Dimensions');
  context.activeCompany = { id: 'company-b' };
  dimensionRead = async key => setting(key, 'false');
  view.rerender(<CompanySettingsPage />);
  await screen.findAllByRole('switch');
  await act(async () => { oldCC.resolve(setting(ccKey, 'true')); oldBU.resolve(setting(buKey, 'true')); });
  for (const toggle of screen.getAllByRole('switch')) expect(toggle).toHaveAttribute('aria-checked', 'false');
});

it('keeps an in-flight save locked and receives its result across a tab round-trip', async () => {
  const pendingSave = deferred();
  const normalFetch = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, options) => options?.method === 'PUT'
    ? pendingSave.promise : normalFetch(url, options));
  render(<CompanySettingsPage />);
  await screen.findAllByRole('switch');
  fireEvent.click(screen.getAllByRole('switch')[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: 'Company Details', exact: true })[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: 'Dimensions', exact: true })[0]!);
  await screen.findAllByRole('switch');
  expect(screen.getAllByRole('switch')[0]).toBeDisabled();
  await act(async () => { pendingSave.resolve(Response.json({ success: true, data: { updated: true } })); });
  expect(screen.getAllByRole('switch')[0]).toHaveAttribute('aria-checked', 'false');
  expect(screen.getAllByRole('switch')[0]).not.toBeDisabled();
});

it('does not apply a previous company save result to the new company', async () => {
  const pendingSave = deferred();
  const normalFetch = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, options) => options?.method === 'PUT'
    ? pendingSave.promise : normalFetch(url, options));
  const view = render(<CompanySettingsPage />);
  await screen.findAllByRole('switch');
  fireEvent.click(screen.getAllByRole('switch')[0]!);
  context.activeCompany = { id: 'company-b' };
  view.rerender(<CompanySettingsPage />);
  await screen.findAllByRole('switch');
  await act(async () => { pendingSave.resolve(Response.json({ success: true, data: { updated: true } })); });
  expect(screen.getAllByRole('switch')[0]).toHaveAttribute('aria-checked', 'true');
});
