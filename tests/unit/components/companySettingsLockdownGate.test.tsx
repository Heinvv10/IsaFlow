// Company settings (wave 2 L): a refused Lockdown Date keeps the old date in state, so Save is blocked until
// the field holds a date it accepted, or the lockdown is switched off.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CompanySettingsPage from '../../../pages/accounting/company-settings';
import { apiFetch } from '@/lib/apiFetch';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'company-a' }, loading: false }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { tab: 'general' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).startsWith('/api/accounting/companies?')) {
      return Response.json({ success: true, data: { id: 'company-a', name: 'Example', lockdown_enabled: true, lockdown_date: '2026-02-28' } });
    }
    if (String(url).includes('financial-year-end-change')) return new Response('{}', { status: 503 });
    return Response.json({ success: true, data: [] });
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const save = () => screen.getByRole('button', { name: /Save Changes/ }) as HTMLButtonElement;
const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');

it('a refused Lockdown Date blocks Save; a good date unblocks it', async () => {
  render(<CompanySettingsPage />);
  const field = await screen.findByRole('textbox', { name: 'Lockdown Date' });
  await waitFor(() => expect(save().disabled).toBe(false));
  typeDate(field, 'garbage');
  await waitFor(() => expect(save().disabled).toBe(true));
  fireEvent.click(save());
  expect(puts()).toEqual([]);
  typeDate(field, '31 Mar 2026');
  await waitFor(() => expect(save().disabled).toBe(false));
});

it('switching the lockdown off drops the refused entry, so Save is open again', async () => {
  render(<CompanySettingsPage />);
  typeDate(await screen.findByRole('textbox', { name: 'Lockdown Date' }), 'garbage');
  await waitFor(() => expect(save().disabled).toBe(true));
  fireEvent.click(screen.getByRole('switch', { name: /Enable Lockdown Date/ }));
  await waitFor(() => expect(save().disabled).toBe(false));
});

it('leaving the General tab drops the refused entry (the field shows the saved date on return), so Save is open', async () => {
  render(<CompanySettingsPage />);
  typeDate(await screen.findByRole('textbox', { name: 'Lockdown Date' }), 'garbage');
  await waitFor(() => expect(save().disabled).toBe(true));
  fireEvent.click(screen.getAllByRole('button', { name: /VAT Settings/ })[0] as HTMLElement);
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Lockdown Date' })).toBeNull());
  expect(save().disabled).toBe(false);
});
