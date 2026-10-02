/**
 * D2 success paths for the load-on-mount admin screens in d2ErrorEnvelopeG4a: a valid 200
 * `{ success:true, data }` envelope is painted. Real apiJson/assertOk run over a scripted apiFetch.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'u-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import BillingOverviewPage from '../../../pages/admin/billing/index';
import InvoicesPage from '../../../pages/admin/billing/invoices';
import PlansPage from '../../../pages/admin/billing/plans';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';
import FeaturesPage from '../../../pages/admin/features';
import HealthPage from '../../../pages/admin/health';
import AdminDashboard from '../../../pages/admin/index';
import SarsCodesPage from '../../../pages/admin/payroll/sars-codes';
import UsersPage from '../../../pages/admin/users/index';
import UserDetailPage from '../../../pages/admin/users/[id]';
import { UserAuditLog } from '@/components/admin/users/UserAuditLog';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const success = (data: unknown) => json({ success: true, data });
const pathOf = (u: unknown) => String(u).split('?')[0];
/** Answer each path from `routes`; anything else with an empty success. */
function serve(routes: Record<string, unknown>) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
    success(pathOf(url)! in routes ? routes[pathOf(url)!] : {}));
}
const PAGE = { total: 1, page: 1, limit: 25 };
const D = '2026-01-01T00:00:00Z';

afterEach(() => { cleanup(); });

describe('load-on-mount admin screens render the data they received', () => {
  it('success: billing overview renders the data it received', async () => {
    serve({
      '/api/admin/billing/overview': { mrr_cents: 0, arr_cents: 0, total_subscriptions: 1, active_subscriptions: 4242, past_due_count: 0,
        trial_count: 0, churn_rate_percent: 0, arpu_cents: 0, total_revenue_cents: 0, outstanding_cents: 0 },
      '/api/admin/billing/subscriptions': { items: [{ id: 's1', company_name: 'Zebra Holdings', plan_name: 'Gold', status: 'active',
        billing_cycle: 'monthly', monthly_amount_cents: 100, created_at: D }] },
    });
    render(<BillingOverviewPage />);
    expect(await screen.findByText('Zebra Holdings')).toBeTruthy();
    expect(screen.getByText('4242')).toBeTruthy();
  });

  it('success: billing invoices list renders the data it received', async () => {
    serve({ '/api/admin/billing/invoices': { ...PAGE, items: [{ id: 'i1', invoice_number: 'INV-7731', company_id: 'c1', company_name: 'Quokka Ltd',
      status: 'draft', subtotal_cents: 100, tax_cents: 15, total_cents: 115, currency: 'ZAR', due_date: null, paid_at: null, payment_method: null, created_at: D }] } });
    render(<InvoicesPage />);
    expect(await screen.findByText('INV-7731')).toBeTruthy();
    expect(screen.getByText('Quokka Ltd')).toBeTruthy();
  });

  it('success: billing plans list renders the data it received', async () => {
    serve({ '/api/admin/billing/plans': [{ id: 'p1', code: 'platinum9', name: 'Platinum Nine', description: '', monthly_price_cents: 100,
      annual_price_cents: 1000, currency: 'ZAR', features: {}, limits: {}, is_active: true, display_order: 1, created_at: D }] });
    render(<PlansPage />);
    expect(await screen.findByText('Platinum Nine')).toBeTruthy();
    expect(screen.getByText('platinum9')).toBeTruthy();
  });

  it('success: billing subscriptions list renders the data it received', async () => {
    serve({ '/api/admin/billing/subscriptions': { ...PAGE, items: [{ id: 's1', company_id: 'c1', company_name: 'Narwhal Co', plan_id: 'p1',
      plan_name: 'Gold', plan_code: 'gold', status: 'active', billing_cycle: 'monthly', current_period_start: null, current_period_end: null,
      cancel_at_period_end: false, discount_percent: 37, monthly_amount_cents: 100, created_at: D }] } });
    render(<SubscriptionsPage />);
    expect(await screen.findByText('Narwhal Co')).toBeTruthy();
    expect(screen.getByText('37%')).toBeTruthy();
  });

  it('success: feature flags list renders the data it received', async () => {
    serve({ '/api/admin/features': [{ id: 'f1', code: 'flag_x', name: 'Hyperdrive Beta', description: null, is_global: true, created_at: D }] });
    render(<FeaturesPage />);
    expect(await screen.findByText('Hyperdrive Beta')).toBeTruthy();
  });

  it('success: system health renders the data it received', async () => {
    serve({ '/api/admin/health': { db: { status: 'ok', latency_ms: 1, size_mb: 8123, }, job_queue: { pending: 0, running: 0, failed: 0, oldest_pending_age_minutes: null },
      email: { sent_24h: 0, failed_24h: 0, success_rate_percent: 100 }, active_sessions_24h: 0, trials: { expiring_in_7d: 0 },
      recent_errors: [{ id: 'e1', action: 'boom.exploded', target_type: 'job', details: {}, created_at: D }], overall_status: 'healthy', checked_at: D } });
    render(<HealthPage />);
    expect(await screen.findByText('8123 MB')).toBeTruthy();
    expect(screen.getByText('boom.exploded')).toBeTruthy();
  });

  it('success: admin dashboard renders the data it received', async () => {
    serve({ '/api/admin/dashboard-stats': { total_companies: 7741, active_companies: 1, total_users: 1, active_users_30d: 1, mrr_cents: 0, arr_cents: 0,
      new_signups_30d: 1, recent_activity: [{ id: 'a1', type: 'signup', description: 'Pangolin joined', user_name: 'U', company_name: 'C', created_at: D }] } });
    render(<AdminDashboard />);
    expect(await screen.findByText('7741')).toBeTruthy();
    expect(screen.getByText('Pangolin joined')).toBeTruthy();
  });

  it('success: SARS codes list renders the data it received', async () => {
    serve({ '/api/admin/payroll/sars-codes': { taxYear: 2027, releases: [{ effective_year: 2027, brs_version: 'v25.2.0', released_at: D, is_current: false, notes: null, code_count: 1 }],
      codes: [{ code: '3601', effective_year: 2027, category: 'income', description: 'Axolotl allowance', status: 'active', foreign_code: null, code_pair: null,
        applicability_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: 'v25.2.0', imported_at: D, used_by_companies: 0 }] } });
    render(<SarsCodesPage />);
    expect(await screen.findByText('Axolotl allowance')).toBeTruthy();
  });

  it('success: users list renders the data it received', async () => {
    serve({ '/api/admin/users': { ...PAGE, items: [{ id: 'u1', first_name: 'Zelda', last_name: 'Quimby', email: 'zq@example.com', phone: null, role: 'admin',
      status: 'active', last_login: null, login_count: 0, created_at: D, account_type: 'direct', company_count: 1, primary_company: 'Acme' }] } });
    render(<UsersPage />);
    expect(await screen.findByText('zq@example.com')).toBeTruthy();
    expect(screen.getByText(/Zelda Quimby/)).toBeTruthy();
  });

  it('success: user detail renders the data it received', async () => {
    serve({ '/api/admin/users/u-1': { id: 'u-1', first_name: 'Yvonne', last_name: 'Zuma', email: 'yz@example.com', phone: null, role: 'admin', status: 'active',
      last_login: null, login_count: 0, created_at: D, account_type: 'direct', bureaus: [], companies: [] } });
    render(<UserDetailPage />);
    expect((await screen.findAllByText(/Yvonne Zuma/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('yz@example.com').length).toBeGreaterThan(0);
  });

  it('success: user audit log renders the data it received', async () => {
    serve({ '/api/admin/audit': { items: [{ id: 'au1', action: 'user.frobnicated', entity_type: 'user', entity_id: 'u-1', created_at: D, admin_id: 'a', ip_address: '10.9.8.7', metadata: null }] } });
    render(<UserAuditLog userId="u-1" />);
    expect(await screen.findByText('user.frobnicated')).toBeTruthy();
    expect(screen.getByText('10.9.8.7')).toBeTruthy();
  });
});
