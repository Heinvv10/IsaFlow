/**
 * D2 round 6 (h5): a failed reload clears the stale figures (AP aging), the packages list shows the server
 * message instead of a silent empty card, and the bank-account create flow reports a half-done create truthfully.
 * REAL assertOk / apiErrorMessage over a scripted apiFetch.
 */
import { typeDate, dateFieldInputs } from '../helpers/dateFields';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => {
  const show = (m: string) => { const d = document.createElement('div'); d.setAttribute('data-toast', ''); d.textContent = m; document.body.appendChild(d); };
  return { notify: { error: show, success: show, info: show, warning: show } };
});

import APAgingPage from '../../../pages/accounting/reports/ap-aging';
import { ApplyPackageCard } from '@/components/payroll/ApplyPackageCard';
import BankAccountsPage from '../../../pages/accounting/bank-accounts/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(log.warn).mockClear(); });
afterEach(() => { cleanup(); document.querySelectorAll('[data-toast]').forEach(n => n.remove()); });

const toasts = () => [...document.querySelectorAll('[data-toast]')].map(n => n.textContent ?? '');

describe('AP aging', () => {
  const DATA = {
    rows: [{ id: 'r1', supplier_name: 'D2 Supplier', invoice_number: 'INV-9', invoice_date: '2026-01-01', due_date: '2026-01-31', total_amount: 100, amount_paid: 0, balance_due: 100, days_overdue: 5, bucket: '1-30' }],
    summary: [{ bucket: '1-30', count: 1, total: 100 }], as_at_date: '2026-02-05',
  };
  it('a failed reload clears the rows and disables Export', async () => {
    let gets = 0;
    route(() => { gets += 1; return gets === 1 ? ok(DATA) : empty500(); });
    const { container } = render(<APAgingPage />);
    expect(await screen.findByText('D2 Supplier')).toBeTruthy();
    typeDate(dateFieldInputs(container)[0]!, '2026-01-15');
    expect(await screen.findByText(/Could not load the AP aging - try again/)).toBeTruthy();
    expect(screen.queryByText('D2 Supplier')).toBeNull();
    expect((screen.getByRole('button', { name: /export csv/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(noRawText()).toBe(true);
  });
});

describe('ApplyPackageCard', () => {
  it('a refused package load shows the server message, not a silent "No active packages"', async () => {
    route(() => bad(403));
    render(<ApplyPackageCard employeeId="e-1" />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-body 500 shows a plain sentence', async () => {
    route(() => empty500());
    render(<ApplyPackageCard employeeId="e-1" />);
    expect(await screen.findByText('Could not load packages - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('200 lists the packages', async () => {
    route(() => ok([{ id: 'p1', code: 'PKG1', name: 'D2 Package', isActive: true }]));
    render(<ApplyPackageCard employeeId="e-1" />);
    expect(await screen.findByText('PKG1 — D2 Package')).toBeTruthy();
  });
});

describe('bank accounts', () => {
  const fill = async () => {
    fireEvent.click((await screen.findAllByRole('button', { name: /add bank account/i }))[0]!);
    fireEvent.change(await screen.findByPlaceholderText('e.g. Bank - FNB Current'), { target: { value: 'D2 Current' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 1114'), { target: { value: '1114' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 4078012345'), { target: { value: '123456' } });
  };
  it('the code suggestion failing is logged, and the modal stays usable', async () => {
    route((u) => (u.includes('next-code') ? empty500() : ok([])));
    render(<BankAccountsPage />);
    await fill();
    await waitFor(() => expect(log.warn).toHaveBeenCalled());
    expect((screen.getByPlaceholderText('e.g. 1114') as HTMLInputElement).value).toBe('1114');
  });
  it('the number PUT dropping at transport level: says the account exists, reloads, no "could not create"', async () => {
    let lists = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
      const u = String(url); const m = (init?.method ?? 'GET').toUpperCase();
      if (u.includes('next-code')) return ok({ code: '1114' });
      if (m === 'POST') return ok({ id: 'new-1' });
      if (m === 'PUT') throw new TypeError('network down');
      lists += 1;
      return ok([]);
    });
    render(<BankAccountsPage />);
    await fill();
    const before = lists;
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(toasts().some(t => /was created, but its bank account number was not saved/.test(t))).toBe(true));
    expect(toasts().some(t => /Could not create the bank account/.test(t))).toBe(false);
    await waitFor(() => expect(lists).toBeGreaterThan(before));
    expect(screen.queryByPlaceholderText('e.g. 1114')).toBeNull();
  });
});
