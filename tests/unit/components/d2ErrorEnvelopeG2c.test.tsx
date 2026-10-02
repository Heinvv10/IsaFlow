/**
 * D2 error envelope, group g2c: sales reps, account reporting groups and exchange rates show the
 * server's message from a real { success:false, error:{ code, message } } envelope, not the old
 * generic / "Network error" fallbacks.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const notifyMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Acme' } }) }));
vi.mock('@/components/accounting/AccountReportingGroupModal', () => ({ AccountReportingGroupModal: () => null }));
vi.mock('@/utils/toast', () => ({ notify: notifyMock }));

import { apiFetch } from '@/lib/apiFetch';
import SalesRepsPage from '../../../pages/accounting/sales-reps';
import AccountReportingGroupsPage from '../../../pages/accounting/settings/account-reporting-groups';
import ExchangeRatesSettingsPage from '../../../pages/accounting/settings/exchange-rates';

void mockedApiFetchModule;
useApiJsonOverMock();

type Handler = (url: string, init?: RequestInit) => Response | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (message: string, status = 422) => json({ success: false, error: { code: 'VALIDATION_ERROR', message } }, status);

function script(handler: Handler) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => handler(String(url), init) ?? ok({}));
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); notifyMock.error.mockReset(); notifyMock.success.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REP = { id: 'rep-1', name: 'Jane Smith', email: 'j@x.co', phone: null, is_active: true, created_at: '2026-01-01' };

it('sales reps: a refused list load shows the server message', async () => {
  const MSG = 'D2 server says no: sales reps need the Sales add-on';
  script((u) => (u.includes('/sales-reps') ? refuse(MSG, 403) : undefined));
  render(<SalesRepsPage />);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText(/Failed to load sales reps/)).toBeNull();
  expect(screen.queryByText(/Network error/)).toBeNull();
});

it('sales reps: a refused save shows the server message in the modal', async () => {
  const MSG = 'D2 server says no: a sales rep with this email already exists';
  script((u, init) => {
    if (u.includes('/sales-reps')) return init?.method === 'PUT' ? refuse(MSG, 409) : ok([REP]);
    return undefined;
  });
  render(<SalesRepsPage />);
  await screen.findByText('Jane Smith');
  fireEvent.click(screen.getByTitle('Edit'));
  fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Save failed')).toBeNull();
  expect(screen.queryByText(/Network error/)).toBeNull();
});

it('sales reps: a refused deactivate shows the server message', async () => {
  const MSG = 'D2 server says no: this rep still owns 4 open quotes';
  vi.stubGlobal('confirm', () => true);
  script((u, init) => {
    if (u.includes('/sales-reps')) return init?.method === 'PUT' ? refuse(MSG, 409) : ok([REP]);
    return undefined;
  });
  render(<SalesRepsPage />);
  await screen.findByText('Jane Smith');
  fireEvent.click(screen.getByTitle('Deactivate'));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Update failed')).toBeNull();
  expect(screen.queryByText(/Network error/)).toBeNull();
});

const GROUP = { id: 'g-1', name: 'Fixed Assets', report_type: 'balance_sheet', display_order: 0, member_count: 0, members: [], created_at: '2026-01-01' };

it('account reporting groups: a refused load shows the server message', async () => {
  const MSG = 'D2 server says no: reporting groups need the Reporting add-on';
  script((u) => (u.includes('/account-reporting-groups') ? refuse(MSG, 403) : undefined));
  render(<AccountReportingGroupsPage />);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed to load groups')).toBeNull();
  expect(screen.queryByText('Failed to load reporting groups')).toBeNull();
});

it('account reporting groups: a refused delete shows the server message', async () => {
  const MSG = 'D2 server says no: group Fixed Assets is used by a saved report layout';
  script((u, init) => {
    if (u.includes('/account-reporting-groups')) return init?.method === 'DELETE' ? refuse(MSG, 409) : ok({ items: [GROUP] });
    return undefined;
  });
  render(<AccountReportingGroupsPage />);
  await screen.findByText('Fixed Assets');
  fireEvent.click(screen.getByTitle('Delete group'));
  fireEvent.click(screen.getByTitle('Click again to confirm delete'));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed to delete group')).toBeNull();
});

it('exchange rates: a refused delete toasts the server message', async () => {
  const MSG = 'D2 server says no: this rate is referenced by posted foreign-currency journals';
  const rate = { id: 'x-1', fromCurrency: 'USD', toCurrency: 'ZAR', rate: 18.5, effectiveDate: '2026-01-01' };
  script((u, init) => {
    if (u.includes('/exchange-rates')) return init?.method === 'DELETE' ? refuse(MSG, 409) : ok({ rates: [rate] });
    if (u.includes('/currencies')) return ok({ currencies: [] });
    return undefined;
  });
  render(<ExchangeRatesSettingsPage />);
  fireEvent.click(await screen.findByTitle('Delete rate'));
  await vi.waitFor(() => expect(notifyMock.error).toHaveBeenCalledWith(MSG));
  expect(notifyMock.error).not.toHaveBeenCalledWith('Failed to delete rate');
  expect(notifyMock.error).not.toHaveBeenCalledWith('Failed to delete exchange rate');
});

it('success: sales reps renders the data it received and the save completes', async () => {
  let name = 'Jane Smith';
  script((u, init) => {
    if (u.includes('/sales-reps')) {
      if (init?.method === 'PUT') { name = 'Zelda Zeta'; return ok({}); }
      return ok([{ ...REP, name }]);
    }
    return undefined;
  });
  render(<SalesRepsPage />);
  await screen.findByText('Jane Smith');
  fireEvent.click(screen.getByTitle('Edit'));
  fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));
  expect(await screen.findByText('Zelda Zeta')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
});

it('success: account reporting groups renders the data it received and a delete completes', async () => {
  script((u, init) => {
    if (u.includes('/account-reporting-groups')) return init?.method === 'DELETE' ? ok({}) : ok({ items: [{ ...GROUP, name: 'Zeta Intangibles' }] });
    return undefined;
  });
  render(<AccountReportingGroupsPage />);
  await screen.findByText('Zeta Intangibles');
  fireEvent.click(screen.getByTitle('Delete group'));
  fireEvent.click(screen.getByTitle('Click again to confirm delete'));
  await vi.waitFor(() => expect(screen.queryByText('Zeta Intangibles')).toBeNull());
});

it('success: exchange rates renders the data it received and a delete completes', async () => {
  const rate = { id: 'x-1', fromCurrency: 'USD', toCurrency: 'ZAR', rate: 18.123456, effectiveDate: '2026-01-01' };
  script((u, init) => {
    if (u.includes('/exchange-rates')) return init?.method === 'DELETE' ? ok({}) : ok({ rates: [rate] });
    if (u.includes('/currencies')) return ok({ currencies: [] });
    return undefined;
  });
  render(<ExchangeRatesSettingsPage />);
  expect(await screen.findByText('18.123456')).toBeTruthy();
  fireEvent.click(screen.getByTitle('Delete rate'));
  await vi.waitFor(() => expect(notifyMock.success).toHaveBeenCalledWith('Exchange rate deleted'));
  expect(screen.queryByText('18.123456')).toBeNull();
});
