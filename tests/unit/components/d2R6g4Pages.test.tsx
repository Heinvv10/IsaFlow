// D2 round 6 (g4): recurring journals reload after a good write, admin invoices stale rows+total, admin dashboard optional
// widgets, company detail users/features loads, cost centres + fraud signals stale rows. Real assertOk/apiErrorMessage.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
vi.mock('@/components/admin/companies/CompanyBillingTab', () => ({ CompanyBillingTab: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import RecurringJournalsPage from '../../../pages/accounting/recurring-journals/index';
import InvoicesPage from '../../../pages/admin/billing/invoices';
import AdminDashboard from '../../../pages/admin/index';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';
import CostCentresPage from '../../../pages/accounting/cost-centres/index';
import FraudSignalsPage from '../../../pages/accounting/fraud/signals';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const html200 = () => new Response('<html>proxy</html>', { status: 200 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to/);
type Route = (p: string, m: string, n: number) => Response | Promise<Response>;
/** Scripts apiFetch by path+method; `n` counts the calls this exact path+method has had. */
function route(fn: Route) {
  const seen = new Map<string, number>();
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const p = String(url).split('?')[0]!; const m = (init?.method ?? 'GET').toUpperCase();
    const n = (seen.get(`${m} ${p}`) ?? 0) + 1; seen.set(`${m} ${p}`, n);
    return fn(p, m, n);
  });
}
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('recurring journals: reload after a good write', () => {
  const RJ = { id: 'rj-1', templateName: 'D2 Rent Template', frequency: 'monthly', nextRunDate: '2026-11-01', totalAmount: 100, runCount: 0, status: 'active' };
  it('a write that succeeds then a reload that dies is not reported as the write failing', async () => {
    route((p, m, n) => {
      if (p === '/api/accounting/recurring-journals-action') return ok({});
      if (p === '/api/accounting/recurring-journals' && m === 'GET') {
        if (n > 1) throw new TypeError('network down');
        return ok({ items: [RJ] });
      }
      return ok([]);
    });
    render(<RecurringJournalsPage />);
    fireEvent.click(await screen.findByTitle('Pause'));
    expect(await screen.findByText('Could not load recurring journals - try again')).toBeTruthy();
    expect(screen.queryByText('Could not pause this recurring journal')).toBeNull();
    expect(screen.queryByText('D2 Rent Template')).toBeNull();
  });
  it('a refused write shows the server message', async () => {
    route((p, m) => (p === '/api/accounting/recurring-journals-action' ? bad400() : ok(p === '/api/accounting/recurring-journals' && m === 'GET' ? { items: [RJ] } : [])));
    render(<RecurringJournalsPage />);
    fireEvent.click(await screen.findByTitle('Pause'));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-500 load shows a plain sentence and no rows', async () => {
    route((p) => (p === '/api/accounting/recurring-journals' ? empty500() : ok([])));
    render(<RecurringJournalsPage />);
    expect(await screen.findByText('Could not load recurring journals - try again')).toBeTruthy();
    noRaw();
  });
});

describe('admin invoices: a failed reload clears rows and total', () => {
  const INV = { id: 'i-1', invoice_number: 'INV-D2-001', company_id: 'c', company_name: 'D2 Acme', status: 'sent', subtotal_cents: 100, tax_cents: 15, total_cents: 115, currency: 'ZAR', due_date: null, paid_at: null, payment_method: null, created_at: '2026-01-01T00:00:00Z' };
  it('empty 500 on the second load: no stale rows, 0 total, a plain sentence', async () => {
    route((p, _m, n) => (p === '/api/admin/billing/invoices' ? (n === 1 ? ok({ items: [INV], total: 7, page: 1, limit: 25 }) : empty500()) : ok([])));
    const { container } = render(<InvoicesPage />);
    expect(await screen.findByText('INV-D2-001')).toBeTruthy();
    expect(screen.getByText('7 total')).toBeTruthy();
    fireEvent.change(container.querySelector('select')!, { target: { value: 'paid' } });
    expect(await screen.findByText('Could not load invoices - try again')).toBeTruthy();
    expect(screen.queryByText('INV-D2-001')).toBeNull();
    expect(screen.getByText('0 total')).toBeTruthy();
    noRaw();
  });
});

describe('admin dashboard: optional widgets', () => {
  const S = { total_companies: 42, active_companies: 40, total_users: 99, active_users_30d: 50, mrr_cents: 0, arr_cents: 0, new_signups_30d: 3, recent_activity: [] };
  it('a non-JSON 200 from health and trials keeps the stats that loaded', async () => {
    route((p) => (p === '/api/admin/dashboard-stats' ? ok(S) : html200()));
    render(<AdminDashboard />);
    expect(await screen.findByText('Total Companies')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.queryByText(/could not load the dashboard/i)).toBeNull();
  });
  it('an empty-500 stats load shows a plain sentence and no figures', async () => {
    route(() => empty500());
    render(<AdminDashboard />);
    expect(await screen.findByText('Could not load the dashboard - try again')).toBeTruthy();
    expect(screen.queryByText('Total Companies')).toBeNull();
    noRaw();
  });
});

describe('admin company detail: users and features tabs', () => {
  const D = { id: 'x-1', name: 'D2 Acme Ltd', trading_name: null, registration_number: null, vat_number: null, email: null, phone: null, website: null,
    billing_email: null, billing_contact: null, address_line1: null, city: null, province: null, postal_code: null, plan_name: 'Starter',
    billing_cycle: 'monthly', status: 'active', created_at: '2026-01-01T00:00:00Z', last_active: null };
  const detail = (failPath: string, fail: () => Response) => route((p) => (p === '/api/admin/companies/x-1' ? ok(D) : p === failPath ? fail() : ok([])));
  for (const [tab, path, sentence] of [['users', '/api/admin/companies/x-1/users', 'Could not load the company users - try again'], ['features', '/api/admin/companies/x-1/features', 'Could not load the company features - try again']] as const) {
    it(`${tab} 400: the server message`, async () => { detail(path, bad400); render(<CompanyDetailPage />); fireEvent.click(await screen.findByRole('button', { name: tab })); expect(await screen.findByText(MSG)).toBeTruthy(); });
    it(`${tab} empty 500: a plain sentence`, async () => { detail(path, empty500); render(<CompanyDetailPage />); fireEvent.click(await screen.findByRole('button', { name: tab })); expect(await screen.findByText(sentence)).toBeTruthy(); noRaw(); });
    it(`${tab} non-JSON 200: a plain sentence, no parse error`, async () => { detail(path, html200); render(<CompanyDetailPage />); fireEvent.click(await screen.findByRole('button', { name: tab })); expect(await screen.findByText(sentence)).toBeTruthy(); noRaw(); });
  }
});

describe('stale rows after a failed load', () => {
  it('cost centres: a failing reload after a save clears the rows and says so', async () => {
    route((p, m, n) => {
      if (p === '/api/accounting/cost-centres' && m === 'GET') return n === 1 ? ok({ items: [{ id: 'cc-1', code: 'D2CC', name: 'D2 Centre', ccType: 'cc1', isActive: true }] }) : empty500();
      return ok({});
    });
    render(<CostCentresPage />);
    expect((await screen.findAllByText('D2 Centre')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /cc2/i }));
    expect(await screen.findByText('Could not load cost centres - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Centre')).toBeNull());
    noRaw();
  });
  it('fraud signals: an empty-500 load shows a plain sentence, not "Failed" or "Network error"', async () => {
    route(() => empty500());
    render(<FraudSignalsPage />);
    expect(await screen.findByText('Could not load fraud signals - try again')).toBeTruthy();
    noRaw();
  });
});
