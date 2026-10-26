/**
 * Edges of the list empty states: a failed load is an error (never "No ... yet" or the demo offer), a page past the
 * last result is not a first run, every active filter counts as filtered, and the supplier invoice table decides
 * first-run vs filtered vs past-the-end the same way.
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
const state = vi.hoisted(() => ({
  nameCustomer: () => undefined, clearAll: () => undefined, setPage: () => undefined,
  filters: { status: 'all', search: '', customerId: '', from: '', to: '', aging: [] as string[], page: 1 },
}));
vi.mock('@/components/accounting/customer-invoices/useCustomerInvoiceListState', () => ({
  useCustomerInvoiceListState: () => ({
    filters: state.filters, hydrated: true, customerLabel: '', nameCustomer: state.nameCustomer, clearAll: state.clearAll, setPage: state.setPage,
  }),
}));
vi.mock('@/components/accounting/customer-invoices/ARFilterBar', () => ({ ARFilterBar: () => null }));

import CustomersPage from '../../../pages/accounting/customers/index';
import SuppliersPage from '../../../pages/accounting/suppliers/index';
import EmployeesPage from '../../../pages/payroll/employees/index';
import RunsPage from '../../../pages/payroll/runs/index';
import CustomerInvoicesPage from '../../../pages/accounting/customer-invoices/index';
import { InvoiceTable } from '../../../src/components/accounting/supplier-invoices/InvoiceTable';

const OFFER = 'Try the demo company';
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const BASE = { status: 'all', search: '', customerId: '', from: '', to: '', aging: [] as string[], page: 1 };
let answer: (url: string) => Response;

beforeEach(() => {
  state.filters = { ...BASE };
  answer = () => json([]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => answer(String(url))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('a failed load is an error, not a first run', () => {
  it.each([
    ['customers', CustomersPage, 'Could not load customers - try again', 'No customers yet'],
    ['suppliers', SuppliersPage, 'Could not load the suppliers - try again', 'No suppliers yet'],
    ['employees', EmployeesPage, 'Could not load employees - try again', 'No employees yet'],
    ['runs', RunsPage, 'Could not load payroll runs - try again', 'No payroll runs yet'],
    ['customer invoices', CustomerInvoicesPage, 'Could not load the customer invoices - try again', 'No invoices yet'],
  ])('%s', async (_n, Page, message, firstRun) => {
    answer = () => new Response('', { status: 500 });
    render(<Page />);
    expect(await screen.findByText(message as string)).toBeTruthy();
    expect(screen.queryByText(firstRun as string)).toBeNull();
    expect(screen.queryByText(OFFER)).toBeNull();
  });
});

describe('a page past the last result is not a first run', () => {
  it('suppliers: rows empty but the server counts 30', async () => {
    answer = () => json({ suppliers: [], total: 30 });
    render(<SuppliersPage />);
    expect(await screen.findByText('Nothing on this page')).toBeTruthy();
    expect(screen.queryByText('No suppliers yet')).toBeNull();
    expect(screen.queryByText(OFFER)).toBeNull();
  });
  it('customer invoices: ?page=9 with 30 invoices offers the first page, not the demo', async () => {
    state.filters = { ...BASE, page: 9 };
    answer = () => json({ invoices: [], total: 30 });
    render(<CustomerInvoicesPage />);
    expect(await screen.findByText('Nothing on this page')).toBeTruthy();
    expect(screen.queryByText('No invoices yet')).toBeNull();
    expect(screen.queryByText(OFFER)).toBeNull();
    expect(screen.getByRole('button', { name: 'Go to the first page' })).toBeTruthy();
  });
});

describe('customer invoices: each active filter makes the empty result "filtered"', () => {
  it.each([
    ['status', { status: 'overdue' }],
    ['search', { search: 'acme' }],
    ['customer', { customerId: 'c-1' }],
    ['from', { from: '2026-01-01' }],
    ['to', { to: '2026-01-31' }],
    ['aging', { aging: ['30'] }],
  ])('%s', async (_n, patch) => {
    state.filters = { ...BASE, ...(patch as object) };
    answer = () => json({ invoices: [], total: 0 });
    render(<CustomerInvoicesPage />);
    expect(await screen.findByText('No results')).toBeTruthy();
    expect(screen.queryByText(OFFER)).toBeNull();
  });
});

describe('suppliers and employees', () => {
  it('suppliers: first run, then a search with no match, then clear', async () => {
    answer = () => json({ suppliers: [], total: 0 });
    render(<SuppliersPage />);
    expect(await screen.findByText('No suppliers yet')).toBeTruthy();
    expect(screen.getByText(OFFER)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'zzz' } });
    expect(await screen.findByText('No results', undefined, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText(OFFER)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No suppliers yet', undefined, { timeout: 2000 })).toBeTruthy();
  });
  it('employees: a search that matches nobody says No results and never offers the demo', async () => {
    answer = () => json([{ id: 'e1', employeeNumber: 'E-1', firstName: 'Ann', lastName: 'Lee', employmentType: 'permanent', startDate: '2020-01-01T00:00:00Z' }]);
    render(<EmployeesPage />);
    await screen.findByText('Ann Lee');
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'zzz' } });
    expect(await screen.findByText('No results')).toBeTruthy();
    expect(screen.queryByText(OFFER)).toBeNull();
  });
});

describe('<InvoiceTable> empty branch', () => {
  const props = {
    invoices: [], selected: new Set<string>(), toggleRow: vi.fn(), toggleAll: vi.fn(), sort: 'invoice_date', sortOrder: 'desc',
    onSort: vi.fn(), page: 1, perPage: 25, total: 0, onPage: vi.fn(), onPerPage: vi.fn(), filtersActive: false,
  } as unknown as React.ComponentProps<typeof InvoiceTable>;
  it('first run: signature state and the demo offer', () => {
    render(<InvoiceTable {...props} />);
    expect(screen.getByText('No supplier invoices yet')).toBeTruthy();
    expect(screen.getByText(OFFER)).toBeTruthy();
  });
  it('filtered: No results with Clear filters, no demo', () => {
    const clear = vi.fn();
    render(<InvoiceTable {...props} filtersActive onClearFilters={clear} />);
    expect(screen.getByText('No results')).toBeTruthy();
    expect(screen.queryByText(OFFER)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(clear).toHaveBeenCalled();
  });
  it('past the end: the first page, no demo', () => {
    const onPage = vi.fn();
    render(<InvoiceTable {...props} page={4} total={60} onPage={onPage} />);
    expect(screen.queryByText(OFFER)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the first page' }));
    expect(onPage).toHaveBeenCalledWith(1);
  });
});

describe('the demo banner never goes by name', () => {
  it('a customer company called "Demo Plumbing" gets no banner and the real demo is skipped as the real company', async () => {
    vi.resetModules();
    vi.doMock('@/contexts/CompanyContext', () => ({
      useCompany: () => ({
        activeCompany: { id: 'dp', name: 'Demo Plumbing', isDemo: false }, switchCompany: vi.fn(),
        companies: [{ companyId: 'dp', companyName: 'Demo Plumbing', role: 'owner', isDefault: true, isDemo: false }],
      }),
    }));
    vi.doMock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
    const { DemoBanner } = await import('../../../src/components/layout/DemoBanner');
    const { container } = render(<DemoBanner />);
    expect(container.textContent).toBe('');
  });
  it('on the real demo tenant, "Demo Plumbing" is a valid company to go back to', async () => {
    vi.resetModules();
    vi.doMock('@/contexts/CompanyContext', () => ({
      useCompany: () => ({
        activeCompany: { id: 'd', name: 'ISAFlow Demo (Pty) Ltd', isDemo: true }, switchCompany: vi.fn(),
        companies: [
          { companyId: 'd', companyName: 'ISAFlow Demo (Pty) Ltd', role: 'owner', isDefault: false, isDemo: true },
          { companyId: 'dp', companyName: 'Demo Plumbing', role: 'owner', isDefault: true, isDemo: false },
        ],
      }),
    }));
    vi.doMock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
    const { DemoBanner } = await import('../../../src/components/layout/DemoBanner');
    render(<DemoBanner />);
    await waitFor(() => expect(document.body.textContent).toContain('Demo Plumbing'));
  });
});
