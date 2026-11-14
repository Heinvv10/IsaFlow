/**
 * Admin metric screens (audit 2.1, 2.4, 2.5, 2.8): a rate or amount the API
 * sends as null shows a dash, never 0% / R0 / 100%; a real 0% stays 0%; the
 * invoice totals say they are admin invoices only; the health widgets say
 * what they measure; a failed platform-health load on the dashboard says so.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import BillingOverviewPage from '../../../pages/admin/billing/index';
import HealthPage from '../../../pages/admin/health';
import AdminDashboard from '../../../pages/admin/index';
import { CohortRetentionTable } from '@/components/admin/charts/CohortRetentionTable';
import { SubscriptionCard } from '@/components/admin/companies/BillingTabParts';
import { RevenueIntelligenceSection } from '@/components/admin/RevenueIntelligenceSection';

const SCOPE = 'Active subscriptions only; excludes trials, past due, suspended and internal companies';

void mockedApiFetchModule;
useApiJsonOverMock();
afterEach(cleanup);

const pathOf = (u: unknown) => String(u).split('?')[0]!;
function serve(routes: Record<string, unknown>, failing: string[] = []) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = pathOf(url);
    if (failing.includes(path)) return new Response(JSON.stringify({ success: false, error: { message: 'x' } }), { status: 500 });
    return new Response(JSON.stringify({ success: true, data: path in routes ? routes[path] : {} }), { status: 200 });
  });
}
/** The value printed in the StatsCard / Stat whose label is `label`. */
const valueOf = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('billing overview', () => {
  const overview = { mrr_cents: 0, arr_cents: 0, total_subscriptions: 1, active_subscriptions: 1, past_due_count: 0,
    trial_count: 0, paying_companies: 0, churn_rate_percent: null, churn_period: '2026-11-01', arpu_cents: null,
    total_revenue_cents: 0, outstanding_cents: 0 };
  it('no paying company and no churn base: dashes, not R0 and 0.0%', async () => {
    serve({ '/api/admin/billing/overview': overview, '/api/admin/billing/subscriptions': { items: [] } });
    render(<BillingOverviewPage />);
    await screen.findByText('ARPU');
    expect(valueOf('ARPU')).toBe('—');
    expect(valueOf('Churn Rate')).toBe('—');
    expect(valueOf('Paying Companies')).toBe('0');
  });
  it('a real churn of 0% still reads 0.0%; the invoice totals are labelled as admin invoices', async () => {
    serve({ '/api/admin/billing/overview': { ...overview, churn_rate_percent: 0, arpu_cents: 59_900, paying_companies: 1 },
      '/api/admin/billing/subscriptions': { items: [] } });
    render(<BillingOverviewPage />);
    await screen.findByText('ARPU');
    expect(valueOf('Churn Rate')).toBe('0.0%');
    // Round 2 M2: the period the churn figure covers.
    expect(screen.getByText('Churn Rate').parentElement?.textContent).toContain('Nov 2026 to date, paying companies');
    expect(valueOf('ARPU')).toContain('599.00');
    expect(screen.queryByText('Total Revenue')).toBeNull();
    expect(screen.getByText('Paid Admin Invoices')).toBeDefined();
    expect(screen.getByText('Unpaid Admin Invoices')).toBeDefined();
  });
});

describe('MRR scope note (review M3)', () => {
  it('billing overview: on the MRR and ARR cards', async () => {
    serve({ '/api/admin/billing/overview': { mrr_cents: 1, arr_cents: 12, total_subscriptions: 1, active_subscriptions: 1,
      past_due_count: 0, trial_count: 0, paying_companies: 1, churn_rate_percent: 0, arpu_cents: 1, total_revenue_cents: 0,
      outstanding_cents: 0 }, '/api/admin/billing/subscriptions': { items: [] } });
    render(<BillingOverviewPage />);
    await screen.findByText('ARR');
    expect(screen.getByText('MRR').parentElement?.textContent).toContain(SCOPE);
    expect(screen.getByText('ARR').parentElement?.textContent).toContain(SCOPE);
  });
  it('dashboard: on the MRR card', async () => {
    serve({ '/api/admin/dashboard-stats': { total_companies: 1, active_companies: 1, total_users: 1, active_users_30d: 0,
      mrr_cents: 0, arr_cents: 0, new_signups_30d: 0, recent_activity: [] }, '/api/admin/trials': [] });
    render(<AdminDashboard />);
    expect((await screen.findByText('MRR')).parentElement?.textContent).toContain(SCOPE);
  });
  it('revenue intelligence: under its heading', async () => {
    serve({ '/api/admin/analytics/revenue': { plan_breakdown: [], churn_trend: [], nrr: null, arpu_cents: null,
      ltv_estimate_cents: null, cohort_retention: [] } });
    render(<RevenueIntelligenceSection />);
    await screen.findByText('Net Revenue Retention');
    expect(screen.getByText(`${SCOPE}.`)).toBeDefined();
  });
  it('revenue intelligence: NRR and churn name the history approximations (round 2 L1, L2)', async () => {
    serve({ '/api/admin/analytics/revenue': { plan_breakdown: [], churn_trend: [], nrr: null, arpu_cents: null,
      ltv_estimate_cents: null, cohort_retention: [] } });
    render(<RevenueIntelligenceSection />);
    await screen.findByText('Net Revenue Retention');
    const text = document.body.textContent ?? '';
    expect(text).toContain('NRR and LTV: History:');
    expect(text).toContain('Paying companies at the start of each month that pay nothing at its end.');
    expect(text).toContain('a paid subscription bought during a trial, or a trial that was extended');
    expect(text).toContain('Past due and paused subscriptions are outside the MRR history and the churn base.');
  });
});

describe('company billing tab (review M4)', () => {
  const sub = { id: 's', company_id: 'c', company_name: 'C', plan_id: 'p', plan_name: 'Pro', plan_code: 'pro', status: 'trial',
    billing_cycle: 'monthly', current_period_start: null, current_period_end: null, cancel_at_period_end: false,
    discount_percent: 0, monthly_amount_cents: 59_900, created_at: '2026-01-01T00:00:00Z' };
  it('a trial shows its monthly amount and that it does not count toward MRR', () => {
    render(<SubscriptionCard subscription={{ ...sub, counts_toward_mrr: false }} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.queryByText('MRR Contribution')).toBeNull();
    expect(valueOf('Monthly amount')).toContain('599.00');
    expect(valueOf('Counts toward MRR')).toBe('No');
  });
  it('an active one says Yes', () => {
    render(<SubscriptionCard subscription={{ ...sub, status: 'active', counts_toward_mrr: true }} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    expect(valueOf('Counts toward MRR')).toBe('Yes');
  });
});

describe('cohort retention table', () => {
  it('a month not yet ended is a dash; a real 0% is 0%', () => {
    render(<CohortRetentionTable data={[{ cohort_month: '2026-10-01', cohort_size: 2, m0_pct: 0, m1_pct: null, m2_pct: null, m3_pct: null }]} />);
    const cells = [...document.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells.slice(2)).toEqual(['0%', '—', '—', '—']);
  });
});

describe('system health', () => {
  const data = {
    db: { status: 'ok', latency_ms: 3, size_mb: 10 },
    job_queue: { pending: 0, running: 0, failed: 2, oldest_pending_age_minutes: null },
    email: { sent_24h: 0, failed_24h: 0, bounced_24h: 0, success_rate_percent: null },
    users_signed_in_24h: 7, trials: { expiring_in_7d: 0 }, recent_errors: [], overall_status: 'healthy', checked_at: '2026-01-01T00:00:00Z',
  };
  it('labels say what is measured; no email sent is a dash, not 100%', async () => {
    serve({ '/api/admin/health': data });
    render(<HealthPage />);
    await screen.findByText('Accepted by SMTP');
    expect(valueOf('Accepted %')).toBe('—');
    expect(screen.queryByText('Success')).toBeNull();
    expect(valueOf('Failed (all time)')).toBe('2');
    expect(screen.getByText('Signed In (24h)')).toBeDefined();
    expect(valueOf('Users')).toBe('7');
    expect(screen.queryByText('Sessions')).toBeNull();
  });
});

describe('dashboard platform health', () => {
  const stats = { total_companies: 1, active_companies: 1, total_users: 1, active_users_30d: 0, mrr_cents: 0, arr_cents: 0,
    new_signups_30d: 0, recent_activity: [] };
  it('a failed load says so instead of hiding the card', async () => {
    serve({ '/api/admin/dashboard-stats': stats, '/api/admin/trials': [] }, ['/api/admin/analytics/health']);
    render(<AdminDashboard />);
    expect(await screen.findByText(/Could not load platform health/)).toBeDefined();
  });
  it('an error rate with no admin activity is a dash', async () => {
    serve({ '/api/admin/dashboard-stats': stats, '/api/admin/trials': [],
      '/api/admin/analytics/health': { active_users_24h: 0, active_users_7d: 0, active_users_30d: 0, db_size_mb: 5, error_rate_percent: null } });
    render(<AdminDashboard />);
    await screen.findByText('Admin error rate (24h)');
    expect(valueOf('Admin error rate (24h)')).toBe('—');
  });
});
