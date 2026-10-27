/**
 * Main list pages: loading is a skeleton (no spinner); an empty list on a true first run shows the
 * signature empty state; an empty list under a search shows "No results" and never the demo offer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }) }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    companyRole: 'owner', activeCompany: { id: 'mine' }, switchCompany: vi.fn(),
    companies: [{ companyId: 'd', companyName: 'Sandbox', role: 'viewer', isDefault: false, isDemo: true }],
  }),
}));
const state = vi.hoisted(() => ({ nameCustomer: () => undefined, clearAll: () => undefined, setPage: () => undefined, filters: { status: 'all', search: '', customerId: '', from: '', to: '', aging: [] as string[], page: 1 } }));
vi.mock('@/components/accounting/customer-invoices/useCustomerInvoiceListState', () => ({
  useCustomerInvoiceListState: () => ({
    filters: state.filters, hydrated: true, customerLabel: '', nameCustomer: state.nameCustomer, clearAll: state.clearAll, setPage: state.setPage,
  }),
}));
vi.mock('@/components/accounting/customer-invoices/ARFilterBar', () => ({ ARFilterBar: () => null }));

import CustomersPage from '../../../pages/accounting/customers/index';
import EmployeesPage from '../../../pages/payroll/employees/index';
import RunsPage from '../../../pages/payroll/runs/index';
import CustomerInvoicesPage from '../../../pages/accounting/customer-invoices/index';

let release: (() => void) | null = null;
const empty = () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
const emptyInvoices = () => new Response(JSON.stringify({ success: true, data: { invoices: [], total: 0 } }), { status: 200 });

beforeEach(() => {
  release = null;
  state.filters = { status: 'all', search: '', customerId: '', from: '', to: '', aging: [], page: 1 };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('customer-invoices-list')) return emptyInvoices();
    if (String(url).includes('slow')) await new Promise<void>((r) => { release = r; });
    return empty();
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('loading is a skeleton', () => {
  it.each([['customers', CustomersPage, 'Loading customers'], ['employees', EmployeesPage, 'Loading employees'], ['runs', RunsPage, 'Loading payroll runs']])(
    '%s shows a busy skeleton with no spinner on first paint', (_n, Page, label) => {
      const { container } = render(<Page />);
      expect(screen.getByRole('status', { name: label as string })).toBeTruthy();
      expect(container.querySelector('.animate-spin')).toBeNull();
    });
});

describe('empty states', () => {
  it('customers: true first run shows the signature empty state and the demo offer', async () => {
    render(<CustomersPage />);
    expect(await screen.findByText('No customers yet')).toBeTruthy();
    expect(screen.getByText('Try the demo company')).toBeTruthy();
  });
  it('customers: an empty search result says No results and clears the search', async () => {
    render(<CustomersPage />);
    await screen.findByText('No customers yet');
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'zzz' } });
    expect(await screen.findByText('No results', undefined, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText('Try the demo company')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No customers yet')).toBeTruthy();
  });
  it('employees and runs show their first-run states', async () => {
    render(<EmployeesPage />);
    expect(await screen.findByText('No employees yet')).toBeTruthy();
    cleanup();
    render(<RunsPage />);
    expect(await screen.findByText('No payroll runs yet')).toBeTruthy();
  });
  it('customer invoices: first run vs a status filter', async () => {
    render(<CustomerInvoicesPage />);
    expect(await screen.findByText('No invoices yet')).toBeTruthy();
    cleanup();
    state.filters = { ...state.filters, status: 'overdue' };
    render(<CustomerInvoicesPage />);
    await waitFor(() => expect(screen.getByText('No results')).toBeTruthy());
    expect(screen.queryByText('Try the demo company')).toBeNull();
  });
});
