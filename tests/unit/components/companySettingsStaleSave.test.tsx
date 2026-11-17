// Company settings (PR #1551): the save sends the financial year start month the form was LOADED with; a 409
// (the month changed since, e.g. a change of year end) shows the server's message and a way to reload.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CompanySettingsPage from '../../../pages/accounting/company-settings';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'company-a' }, loading: false }), useCompanyRoleOrNull: () => 'owner',
}));
const route = vi.hoisted(() => ({ tab: 'details' }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { tab: route.tab } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

const STALE = 'Company settings changed since you loaded them — reload and try again';
let stored = 1;        // financial_year_start in the "database"
let refuse = true;     // the company PUT answers 409

beforeEach(() => {
  route.tab = 'details';
  stored = 1;
  refuse = true;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/companies?')) {
      return Response.json({ success: true, data: { id: 'company-a', name: 'Example', financial_year_start: stored } });
    }
    if (u === '/api/accounting/companies' && (init as RequestInit | undefined)?.method === 'PUT') {
      if (refuse) return Response.json({ success: false, error: { code: 'CONFLICT', message: STALE } }, { status: 409 });
      return Response.json({ success: true, data: { id: 'company-a', name: 'Example', financial_year_start: stored } });
    }
    if (u.includes('financial-year-end-change')) return new Response('{}', { status: 503 });
    return Response.json({ success: true, data: [] });
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const save = () => screen.getByRole('button', { name: /Save Changes/ }) as HTMLButtonElement;
const companyPuts = () => vi.mocked(apiFetch).mock.calls
  .filter(([url, init]) => url === '/api/accounting/companies' && (init as RequestInit | undefined)?.method === 'PUT')
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
const companyGets = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).startsWith('/api/accounting/companies?')).length;

it('sends the loaded month; a 409 shows the message and Reload, which re-reads the company; the next save sends the new month', async () => {
  render(<CompanySettingsPage />);
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());

  await screen.findByText(STALE);
  expect(companyPuts()[0]).toMatchObject({ financialYearStart: 1, loadedFinancialYearStart: 1 });
  expect(screen.queryByText('Changes saved successfully')).toBeNull();

  stored = 3;          // a change of year end committed meanwhile
  refuse = false;
  const before = companyGets();
  fireEvent.click(screen.getByRole('button', { name: /Reload settings/ }));
  await waitFor(() => expect(companyGets()).toBe(before + 1));
  await waitFor(() => expect(screen.queryByText(STALE)).toBeNull());

  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await screen.findByText('Changes saved successfully');
  expect(companyPuts()[1]).toMatchObject({ financialYearStart: 3, loadedFinancialYearStart: 3 });
});

it('another failure (not 409) shows the message without Reload', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/companies?')) return Response.json({ success: true, data: { id: 'company-a', name: 'Example', financial_year_start: 1 } });
    if (u === '/api/accounting/companies' && (init as RequestInit | undefined)?.method === 'PUT') {
      return Response.json({ success: false, error: { code: 'BAD_REQUEST', message: 'vatPeriod is wrong' } }, { status: 400 });
    }
    if (u.includes('financial-year-end-change')) return new Response('{}', { status: 503 });
    return Response.json({ success: true, data: [] });
  });
  render(<CompanySettingsPage />);
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await screen.findByText('vatPeriod is wrong');
  expect(screen.queryByRole('button', { name: /Reload settings/ })).toBeNull();
});

it('Reload re-reads the whole General tab: the year panel loads again, not only the company', async () => {
  route.tab = 'general';
  const yearReads = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes('financial-year-end-change')).length;
  render(<CompanySettingsPage />);
  await waitFor(() => expect(save().disabled).toBe(false));
  await waitFor(() => expect(yearReads()).toBeGreaterThan(0));
  fireEvent.click(save());
  await screen.findByText(STALE);
  const before = yearReads();
  stored = 6;
  refuse = false;
  fireEvent.click(screen.getByRole('button', { name: /Reload settings/ }));
  await waitFor(() => expect(screen.queryByText(STALE)).toBeNull());
  await waitFor(() => expect(yearReads(), 'the year panel kept its pre-Reload year').toBe(before + 1));
});
