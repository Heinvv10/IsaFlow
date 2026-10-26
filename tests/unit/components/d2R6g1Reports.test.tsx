/**
 * D2 round 6 (g1): bank-transactions report, customer-ledger customer list, my-account (a 2xx without data is a failed
 * load), bureau client home, admin migration tool. REAL assertOk / apiErrorMessage over the scripted apiFetch.
 * 4xx -> the server's message; empty-body 500 -> a plain sentence (never JSON / HTTP / bare Failed); a failed
 * (re)load clears the old figures instead of leaving them beside the error.
 */
import { typeDate, dateFieldInputs } from '../helpers/dateFields';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: toast }));
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { companyId: 'co-9' }, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'owner' }, refreshUser: vi.fn() }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' }, switchCompany: vi.fn() }) }));
vi.mock('@/components/accounting/my-account/TwoFactorSection', () => ({ TwoFactorSection: () => null }));
vi.mock('@/components/accounting/my-account/ChangeEmailSection', () => ({ ChangeEmailSection: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/reports/bank-transactions';
import CustomerLedgerPage from '../../../pages/accounting/reports/customer-ledger';
import MyAccountPage from '../../../pages/accounting/my-account';
import BureauClientHomePage from '../../../pages/bureau/clients/[companyId]';
import AdminMigrationsPage from '../../../pages/admin/tools/migrations';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); toast.error.mockReset(); toast.success.mockReset(); notify.error.mockReset(); });

describe('bank transactions report', () => {
  const REPORT = { accountCode: '1000', accountName: 'D2 Bank', openingBalance: 0, closingBalance: 123,
    transactions: [{ date: '2026-01-02', entryNumber: 'JE1', description: 'D2 deposit row', deposit: 123, withdrawal: 0, runningBalance: 123 }] };
  const run = (report: () => Response) => script((u) => (u.includes('chart-of-accounts') ? ok([{ id: 'a1', accountCode: '1000', accountName: 'D2 Bank' }])
    : u.includes('reports-bank-transactions') ? report() : undefined));
  const exportBtn = () => screen.getByRole('button', { name: /export csv/i }) as HTMLButtonElement;

  it('a failing reload clears the old report and disables Export', async () => {
    let failing = false;
    run(() => (failing ? empty500() : ok(REPORT)));
    const { container } = render(<BankTransactionsPage />);
    expect(await screen.findByText('D2 deposit row')).toBeTruthy();
    expect(exportBtn().disabled).toBe(false);
    failing = true;
    typeDate(dateFieldInputs(container)[0]!, '2026-01-01');
    expect(await screen.findByText('Could not load the bank transactions report - try again')).toBeTruthy();
    expect(screen.queryByText('D2 deposit row')).toBeNull();
    expect(exportBtn().disabled).toBe(true);
    expectNoRawError();
  });
  it('a refused load shows the server message', async () => {
    run(refuse); render(<BankTransactionsPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

describe('customer ledger: the customer list', () => {
  const focus = (container: HTMLElement) => fireEvent.focus(container.querySelector('select')!);
  it('an empty-body 500 says the customers could not be loaded', async () => {
    script(() => empty500()); const { container } = render(<CustomerLedgerPage />); focus(container);
    expect(await screen.findByText('Could not load customers - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a refused load shows the server message', async () => {
    script(() => refuse()); const { container } = render(<CustomerLedgerPage />); focus(container);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('a good load fills the list and shows no error', async () => {
    script(() => ok([{ id: 'c1', name: 'D2 Customer One' }])); const { container } = render(<CustomerLedgerPage />); focus(container);
    expect(await screen.findByRole('option', { name: 'D2 Customer One' })).toBeTruthy();
    expect(screen.queryByText(/Could not load customers/)).toBeNull();
  });
});

describe('my-account: a 2xx without data is a failed load', () => {
  const noData = () => new Response(JSON.stringify({ success: true }), { status: 200 });
  const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'PUT').length;
  it('profile: says so and blocks Save', async () => {
    script((u) => (u.includes('profile') ? noData() : ok({ rowsPerPage: '50', navMode: 'top' })));
    render(<MyAccountPage />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load your profile - try again'));
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Y' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Your profile could not be loaded - reload the page before saving'));
    expect(puts()).toBe(0);
  });
  it('preferences: says so and blocks Save', async () => {
    script((u) => (u.includes('preferences') ? noData() : ok({ firstName: 'D2', lastName: 'T', email: 'a@b.c', phone: '', mobile: '' })));
    render(<MyAccountPage />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load your preferences - try again'));
    fireEvent.click(await screen.findByRole('button', { name: /^preferences$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save preferences/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Your preferences could not be loaded - reload the page before saving'));
    expect(puts()).toBe(0);
  });
});

describe('bureau client home load', () => {
  const HOME = { company: { id: 'co-9', name: 'D2 Client Nine', bureauName: 'B' }, metrics: { cash: 1, ar: 2, ap: 3, revenueMtd: 4, profitMtd: 5 }, workItems: [] };
  const err = (status: number, message: string) => () => new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });
  it('404: the bureau copy', async () => { script(err(404, 'Client not found')); render(<BureauClientHomePage />); expect(await screen.findByText('This client is not in your bureau.')).toBeTruthy(); });
  it('400: the server message', async () => { script(refuse); render(<BureauClientHomePage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty-body 500: a plain sentence, never a JSON parse error', async () => {
    script(empty500); render(<BureauClientHomePage />);
    expect(await screen.findByText('Could not load this client - try again')).toBeTruthy(); expectNoRawError();
  });
  it('200: the client home renders', async () => { script(() => ok(HOME)); render(<BureauClientHomePage />); expect((await screen.findAllByText(/D2 Client Nine/)).length).toBeGreaterThan(0); });
});

describe('admin migration tool', () => {
  const COMPANY = { id: 'c1', name: 'D2 Acme', trading_name: null };
  const upload = async (rest: (u: string) => Response | undefined) => {
    script((u) => (u.includes('/api/admin/companies') ? ok({ items: [COMPANY] }) : rest(u)));
    const { container } = render(<AdminMigrationsPage />);
    await screen.findByRole('option', { name: 'D2 Acme' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['a,b'], 'a.csv', { type: 'text/csv' })] } });
  };
  it('a failed companies load says so instead of an empty picker', async () => {
    script(empty500); render(<AdminMigrationsPage />);
    expect(await screen.findByText('Could not load the companies - try again')).toBeTruthy(); expectNoRawError();
  });
  it('parse 400: the server message; empty 500: a plain sentence', async () => {
    await upload(() => refuse()); expect(await screen.findByText(MSG)).toBeTruthy();
    cleanup();
    await upload(() => empty500()); expect(await screen.findByText('Could not read the file - check it and try again')).toBeTruthy(); expectNoRawError();
  });
  it('execute: a refusal shows the message, an empty 500 a plain sentence, never "Migration failed"', async () => {
    const parsed = () => ok({ count: 1, parsed: [{ code: '1000' }] });
    for (const [fail, text] of [[refuse, MSG], [empty500, 'Could not run the migration - try again']] as const) {
      await upload((u) => (u.includes('migration-parse') ? parsed() : fail()));
      fireEvent.click(await screen.findByRole('button', { name: /execute migration/i }));
      expect(await screen.findByText(text)).toBeTruthy(); expect(document.body.textContent).not.toMatch(/Migration failed/);
      cleanup();
    }
  });
});
