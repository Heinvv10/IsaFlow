// D2 round 4: fallback wording. An empty-body 500 (or a dropped connection) on these admin / journal pages shows the
// plain sentence, never a bare "Failed", a status code or a JSON parse error; a 4xx shows the server message.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/charts/MrrTrendChart', () => ({ MrrTrendChart: () => null }));
vi.mock('@/components/admin/charts/EngagementTrendChart', () => ({ EngagementTrendChart: () => null }));
vi.mock('@/components/admin/charts/SignupTrendChart', () => ({ SignupTrendChart: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: ({ onChange }: { onChange: (id: string) => void }) => <button onClick={() => onChange('p1')}>pick D2 Supplier</button> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import RecurringJournalsPage from '../../../pages/accounting/recurring-journals';
import InvoicesPage from '../../../pages/admin/billing/invoices';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';
import CompaniesPage from '../../../pages/admin/companies/index';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';
import AnalyticsPage from '../../../pages/admin/analytics';
import CustomerLedgerPage from '../../../pages/accounting/reports/customer-ledger';
import SupplierLedgerPage from '../../../pages/accounting/reports/supplier-ledger';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to fetch/);
/** `fails(path, method)` answers `fail()`; everything else `rest(path)` (default an empty list). */
function script(fails: (p: string, m: string) => boolean, fail: () => Response | Promise<Response>, rest: (p: string, m: string) => unknown = () => []) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const p = String(url).split('?')[0]!; const m = (init?.method ?? 'GET').toUpperCase();
    return fails(p, m) ? fail() : ok(rest(p, m));
  });
}
const dropped = () => { throw new TypeError('Failed to fetch'); };
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('recurring journals save', () => {
  const ITEM = { id: 'r-1', templateName: 'D2 Monthly rent', frequency: 'monthly', nextRunDate: '2027-06-01', runCount: 0, status: 'active', totalAmount: 1000, lines: [] };
  const save = async (fail: () => Response | Promise<Response>) => {
    script((p, m) => p.includes('/recurring-journals') && m === 'PUT', fail, (p) => (p.includes('/recurring-journals') ? { items: [ITEM] } : []));
    const { container } = render(<RecurringJournalsPage />);
    await screen.findByText('D2 Monthly rent');
    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.submit(container.querySelector('form')!);
  };
  it('empty 500: a plain sentence', async () => { await save(empty500); expect(await screen.findByText('Could not save the recurring journal - try again')).toBeTruthy(); expect(screen.queryByText('Failed')).toBeNull(); noRaw(); });
  it('dropped connection: the same sentence', async () => { await save(dropped); expect(await screen.findByText('Could not save the recurring journal - try again')).toBeTruthy(); });
});

describe('admin billing', () => {
  const INVOICE = { id: 'inv-1', invoice_number: 'INV-1', company_id: 'c1', company_name: 'Acme', status: 'draft', subtotal_cents: 100, tax_cents: 15,
    total_cents: 115, currency: 'ZAR', due_date: null, paid_at: null, payment_method: null, created_at: '2026-01-01T00:00:00Z' };
  it('invoice action (send) on an empty 500: a plain sentence, not "Action failed"', async () => {
    script((p) => p.endsWith('/send'), empty500, (p) => (p === '/api/admin/billing/invoices' ? { items: [INVOICE], total: 1, page: 1, limit: 25 } : {}));
    render(<InvoicesPage />);
    fireEvent.click(await screen.findByTitle('Send'));
    expect(await screen.findByText('Could not send the invoice - try again')).toBeTruthy(); noRaw();
  });
  it('invoice create over a dropped connection: a plain sentence', async () => {
    script((p, m) => p === '/api/admin/billing/invoices' && m === 'POST', dropped, (p) => (p === '/api/admin/billing/invoices' ? { items: [], total: 0, page: 1, limit: 25 } : {}));
    const { container } = render(<InvoicesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /create invoice/i }));
    const inputs = container.querySelectorAll('[role="dialog"] input');
    fireEvent.change(inputs[0]!, { target: { value: 'c9' } }); fireEvent.change(inputs[1]!, { target: { value: '100' } }); fireEvent.change(inputs[3]!, { target: { value: '115' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText('Could not create the invoice - try again')).toBeTruthy();
  });
  it('subscriptions load over a dropped connection: a plain sentence', async () => {
    script((p) => p === '/api/admin/billing/subscriptions', dropped);
    render(<SubscriptionsPage />);
    expect(await screen.findByText('Could not load subscriptions - try again')).toBeTruthy();
  });
});

describe('admin companies list', () => {
  const COMPANY = { id: 'c-1', name: 'D2 Acme Ltd', trading_name: null, plan_name: 'Starter', plan_code: 'starter', status: 'active', user_count: 1, mrr_cents: 0, created_at: '2026-01-01T00:00:00Z', last_active: null };
  const list = (p: string) => (p === '/api/admin/companies' ? { items: [COMPANY], total: 1, page: 1, limit: 25 } : []);
  it('load 400: the server message (was read from json.message)', async () => { script((p) => p === '/api/admin/companies', bad400); render(<CompaniesPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('load empty 500: a plain sentence', async () => { script((p) => p === '/api/admin/companies', empty500); render(<CompaniesPage />); expect(await screen.findByText('Could not load companies - try again')).toBeTruthy(); noRaw(); });
  it('suspend empty 500: a plain sentence', async () => {
    script((p) => p.endsWith('/suspend'), empty500, list);
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByTitle('Suspend'));
    expect(await screen.findByText('Could not suspend the company - try again')).toBeTruthy(); noRaw();
  });
  it('200: the company renders', async () => { script(() => false, empty500, list); render(<CompaniesPage />); expect((await screen.findAllByText('D2 Acme Ltd')).length).toBeGreaterThan(0); });
});

describe('admin company detail', () => {
  const COMPANY = { id: 'x-1', name: 'D2 Acme Ltd', trading_name: null, registration_number: null, vat_number: null, email: null, phone: null, website: null,
    billing_email: null, billing_contact: null, address_line1: null, city: null, province: null, postal_code: null, plan_name: 'Starter', billing_cycle: 'monthly',
    status: 'active', created_at: '2026-01-01T00:00:00Z', last_active: null };
  const get = (status: string) => (p: string) => (p === '/api/admin/companies/x-1' ? { ...COMPANY, status } : []);
  it('suspend empty 500', async () => {
    script((p, m) => p.endsWith('/suspend') && m === 'POST', empty500, get('active'));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^suspend$/i }));
    const b = screen.getAllByRole('button', { name: /^suspend$/i }); fireEvent.click(b[b.length - 1]!);
    expect(await screen.findByText('Could not suspend the company - try again')).toBeTruthy(); noRaw();
  });
  it('activate empty 500', async () => {
    script((p, m) => p.endsWith('/activate') && m === 'POST', empty500, get('suspended'));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^activate$/i }));
    expect(await screen.findByText('Could not activate the company - try again')).toBeTruthy(); noRaw();
  });
  it('delete empty 500', async () => {
    script((p, m) => p === '/api/admin/companies/x-1' && m === 'DELETE', empty500, get('active'));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(await screen.findByText('Could not delete the company - try again')).toBeTruthy(); noRaw();
  });
  it('delete success: the Delete button stays disabled while the page navigates away (no second delete)', async () => {
    script((p, m) => p === '/api/admin/companies/x-1' && m === 'DELETE', () => ok({}), get('active'));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u, i]) => String(u) === '/api/admin/companies/x-1' && i?.method === 'DELETE')).toBe(true));
    await new Promise(r => setTimeout(r, 50));
    expect((screen.getByRole('button', { name: /^delete$/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('edit save empty 500: the same sentence as the dropped connection, not "Could not complete: save"', async () => {
    script((p, m) => p === '/api/admin/companies/x-1' && m === 'PATCH', empty500, get('active'));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Could not save the company - try again')).toBeTruthy(); noRaw();
  });
  it('edit save over a dropped connection: the plain sentence', async () => {
    script((p, m) => p === '/api/admin/companies/x-1' && m === 'PATCH', dropped, get('active'));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Could not save the company - try again')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Could not complete:');
  });
});

describe.each([
  ['admin analytics', () => <AnalyticsPage />, '/api/admin/analytics/usage', 'Could not load the analytics - try again'],
])('%s load', (_n, page, part, sentence) => {
  const open = (fail: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes(part) ? fail() : ok([])));
    render(page());
  };
  it('400: the server message', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence', async () => { open(empty500); expect(await screen.findByText(sentence)).toBeTruthy(); noRaw(); });
});

describe.each([
  ['customer ledger', () => <CustomerLedgerPage />, 'reports-customer-ledger', 'customers', 'Customer'],
  ['supplier ledger', () => <SupplierLedgerPage />, 'reports-supplier-ledger', 'suppliers', 'Supplier'],
])('%s', (_n, page, part, list, who) => {
  const run = async (fail: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes(part)) return fail();
      return u.includes(`/api/accounting/${list}`) ? ok([{ id: 'p1', name: `D2 ${who}` }]) : ok([]);
    });
    const { container } = render(page());
    if (list === 'suppliers') fireEvent.click(screen.getByText('pick D2 Supplier'));
    else {
      const select = container.querySelector('select')!;
      fireEvent.focus(select);
      await screen.findByRole('option', { name: `D2 ${who}` });
      fireEvent.change(select, { target: { value: 'p1' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /run report/i }));
  };
  it('400: the server message (was read from json.message)', async () => { await run(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence, not "Failed"', async () => {
    await run(empty500); expect(await screen.findByText('Could not load the ledger - try again')).toBeTruthy(); expect(screen.queryByText('Failed')).toBeNull(); noRaw();
  });
});
