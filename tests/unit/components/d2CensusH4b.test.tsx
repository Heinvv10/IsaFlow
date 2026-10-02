// D2 census group 4 (b): a failed load shows the server's message (400) or a plain sentence (empty 500), never a blank view or raw JSON.
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, rawJsonError, router } from '../helpers/d2CensusH4';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
const routerState = vi.hoisted(() => ({ query: {} as Record<string, string> }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: routerState.query, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/font/google', () => ({ DM_Serif_Display: () => ({ className: 'serif' }) }));
vi.mock('react-hot-toast', () => ({ default: toastMock }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'super_admin', name: 'D2 User' }, loading: false }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'D2 Co' }, companies: [{ id: 'co-1' }], loading: false }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));
vi.mock('@/components/accounting/dashboard/OverviewTab', () => ({ OverviewTab: () => null }));
vi.mock('@/components/accounting/dashboard/ChartOfAccountsTab', () => ({ ChartOfAccountsTab: () => null }));
vi.mock('@/components/accounting/dashboard/JournalEntriesTab', () => ({ JournalEntriesTab: () => null }));
vi.mock('@/components/accounting/dashboard/FiscalPeriodsTab', () => ({ FiscalPeriodsTab: () => null }));
vi.mock('@/components/accounting/dashboard/ReportsTab', () => ({ ReportsTab: () => null }));
vi.mock('@/components/accounting/my-account/TwoFactorSection', () => ({ TwoFactorSection: () => null }));
vi.mock('@/components/accounting/my-account/ChangeEmailSection', () => ({ ChangeEmailSection: () => null }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import AccountingPage from '../../../pages/accounting/index';
import MyAccountPage from '../../../pages/accounting/my-account';
import AccountTransactionsPage from '../../../pages/accounting/reports/account-transactions';
import SupplierCreditNotePage from '../../../pages/accounting/supplier-credit-notes/[id]';
import TimesheetsPage from '../../../pages/accounting/timesheets/index';

const script = (routes: Array<[string, () => Response]>, fallback: unknown = []) => vi.mocked(apiFetch).mockReset().mockImplementation(router(routes, fallback));
const noRawJson = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
beforeEach(() => { routerState.query = {}; toastMock.error.mockReset(); });
afterEach(() => { cleanup(); });

describe('Accounting dashboard hero figures', () => {
  const SITE = 'kpi-dashboard';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<AccountingPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<AccountingPage />);
    expect(await screen.findByText('Could not load the dashboard figures - try again')).toBeTruthy(); noRawJson();
  });
  it('shows the figures on success', async () => {
    script([[SITE, () => okRes({ kpis: { revenue: { total: 123456 }, receivables: { total: 5 }, cash: { total: 7 } } })]]); render(<AccountingPage />);
    expect(await screen.findByText(/123\.5K/)).toBeTruthy();
  });
});

describe('My account preferences load', () => {
  const PROFILE = () => okRes({ firstName: 'D2', lastName: 'User', email: 'a@b.co', phone: '', mobile: '' });
  const open = (prefs: () => Response) => { script([['/api/auth/profile', PROFILE], ['/api/auth/preferences', prefs]]); render(<MyAccountPage />); };
  it('toasts the server message on a 400', async () => {
    open(bad400); await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(MSG));
  });
  it('toasts a plain sentence on an empty 500', async () => {
    open(empty500); await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not load your preferences - try again'));
    expect(JSON.stringify(toastMock.error.mock.calls)).not.toMatch(rawJsonError);
  });
  it('applies the saved preferences on success', async () => {
    open(() => okRes({ rowsPerPage: '50', navMode: 'side' }));
    fireEvent.click(await screen.findByRole('button', { name: /Preferences/ }));
    expect(((await screen.findAllByRole('combobox'))[0] as HTMLSelectElement).value).toBe('50');
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});

describe('Account transactions cost centre list', () => {
  const REPORT = { accountCode: '1110', accountName: 'D2 Bank', accountType: 'asset', openingBalance: 0, periodNet: 0, closingBalance: 0, transactions: [] };
  const open = (cc: () => Response) => { script([['reports-account-transactions', () => okRes(REPORT)], ['cost-centres', cc]], { items: [], accounts: [] }); render(<AccountTransactionsPage />); };
  it('shows the server message on a 400', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load the cost centres - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the cost centres on success', async () => {
    open(() => okRes({ items: [{ id: 'cc1', code: 'CC1', name: 'D2 Mining' }] }));
    expect(await screen.findByRole('option', { name: 'CC1 — D2 Mining' })).toBeTruthy();
  });
});

describe('Supplier credit note load', () => {
  const SITE = 'supplier-credit-notes?id=';
  const open = (r: () => Response) => { routerState.query = { id: 'n1' }; script([[SITE, r]]); render(<SupplierCreditNotePage />); };
  it('shows the server message on a 400', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load the supplier credit note - try again')).toBeTruthy(); noRawJson();
  });
  it('shows the credit note on success', async () => {
    open(() => okRes({ id: 'n1', creditNoteNumber: 'D2-SCN-5', status: 'draft', supplierName: 'D2 Supplier', creditDate: '2026-01-01', subtotal: 1, taxAmount: 0, totalAmount: 1, createdAt: '2026-01-01' }));
    expect((await screen.findAllByText('D2-SCN-5')).length).toBeGreaterThan(0);
  });
});

describe('Timesheets customer list', () => {
  const open = (customers: () => Response) => { script([['/accounting/customers', customers], ['time-entries', () => okRes({ entries: [] })]]); render(<TimesheetsPage />); };
  it('shows the server message on a 400', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load customers - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the customers on success', async () => {
    open(() => okRes([{ id: 'k1', name: 'D2 Customer Pty' }])); expect(await screen.findByRole('option', { name: 'D2 Customer Pty' })).toBeTruthy();
  });
});
