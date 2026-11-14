// Audit 2026-11-14 item 1.1 / 2.7: a user who never signed in reads "Never" (not an em dash, not "0d"), and a
// company none of whose members ever signed in reads "Never" under Last Active. A real date still renders as a date.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
vi.mock('@/components/admin/charts/MrrTrendChart', () => ({ MrrTrendChart: () => null }));
vi.mock('@/components/admin/charts/EngagementTrendChart', () => ({ EngagementTrendChart: () => null }));
vi.mock('@/components/admin/charts/SignupTrendChart', () => ({ SignupTrendChart: () => null }));
vi.mock('@/components/admin/RevenueIntelligenceSection', () => ({ RevenueIntelligenceSection: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import UsersPage from '../../../pages/admin/users/index';
import CompaniesPage from '../../../pages/admin/companies/index';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';
import AnalyticsPage from '../../../pages/admin/analytics';
import { UserProfileForm } from '@/components/admin/users/UserProfileForm';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const COMPANY = { id: 'x-1', name: 'Never Co', trading_name: null, registration_number: null, vat_number: null, email: null, phone: null,
  website: null, billing_email: null, billing_contact: null, address_line1: null, city: null, province: null, postal_code: null,
  plan_name: 'Starter', plan_code: 'starter', billing_cycle: 'monthly', status: 'active', user_count: 1, mrr_cents: 0,
  created_at: '2026-01-01T00:00:00Z', last_active: null as string | null };
const rowOf = (name: string) => screen.getAllByText(name)[0]!.closest('tr')!;

describe('users list: Last Login', () => {
  const U = { id: 'u-1', email: 'never@example.test', first_name: 'Neve', last_name: 'Seen', role: 'admin', status: 'active',
    company_count: 1, primary_company: 'Never Co', last_login: null as string | null, login_count: 0, created_at: '2026-01-01T00:00:00Z' };
  it('null shows Never', async () => {
    serve((url) => (url.startsWith('/api/admin/users') ? ok({ items: [U], total: 1, page: 1, limit: 25 }) : undefined));
    render(<UsersPage />);
    await screen.findByText('never@example.test');
    expect(within(rowOf('never@example.test')).getByText('Never')).toBeTruthy();
  });
  it('a real timestamp shows a date, not Never', async () => {
    serve((url) => (url.startsWith('/api/admin/users')
      ? ok({ items: [{ ...U, last_login: '2026-11-10T08:00:00Z', login_count: 4 }], total: 1, page: 1, limit: 25 }) : undefined));
    render(<UsersPage />);
    await screen.findByText('never@example.test');
    expect(within(rowOf('never@example.test')).queryByText('Never')).toBeNull();
    expect(rowOf('never@example.test').textContent).toMatch(/2026/);
  });
});

describe('user profile: Last Login', () => {
  const USER = { id: 'u-1', email: 'never@example.test', first_name: 'Neve', last_name: 'Seen', phone: null, role: 'admin', status: 'active',
    last_login: null as string | null, login_count: 0, created_at: '2026-01-01T00:00:00Z', account_type: 'direct', bureaus: [], companies: [] };
  const props = { onSaved: vi.fn(), onError: vi.fn() } as never;
  it('null shows Never', () => {
    render(<UserProfileForm user={USER as never} {...(props as object)} />);
    expect(screen.getByText('Last Login').nextElementSibling?.textContent).toBe('Never');
  });
});

describe('companies: Last Active', () => {
  it('list: null shows Never', async () => {
    serve((url) => (url.split('?')[0] === '/api/admin/companies' ? ok({ items: [COMPANY], total: 1, page: 1, limit: 25 }) : undefined));
    render(<CompaniesPage />);
    await screen.findAllByText('Never Co');
    expect(within(rowOf('Never Co')).getByText('Never')).toBeTruthy();
  });
  it('list: a real timestamp shows a date', async () => {
    serve((url) => (url.split('?')[0] === '/api/admin/companies'
      ? ok({ items: [{ ...COMPANY, last_active: '2026-11-10T08:00:00Z' }], total: 1, page: 1, limit: 25 }) : undefined));
    render(<CompaniesPage />);
    await screen.findAllByText('Never Co');
    expect(within(rowOf('Never Co')).queryByText('Never')).toBeNull();
  });
  it('detail: null shows Never', async () => {
    serve((url) => (url === '/api/admin/companies/x-1' ? ok(COMPANY) : undefined));
    render(<CompanyDetailPage />);
    await screen.findAllByText('Never Co');
    expect(screen.getByText('Last Active').nextElementSibling?.textContent).toBe('Never');
  });
});

describe('analytics churn signals', () => {
  const USAGE = { dau: 0, wau: 0, mau: 0, stickiness_percent: 0, top_pages: [], feature_adoption: [], revenue_by_plan: [] };
  const open = async (signals: unknown[]) => {
    serve((url) => (url === '/api/admin/analytics/usage' ? ok({ ...USAGE, churn_signals: signals }) : undefined));
    render(<AnalyticsPage />);
    await screen.findByText('Gone Co');
    return rowOf('Gone Co');
  };
  it('never signed in: Never in both cells, no "0d"', async () => {
    const row = await open([{ company_id: 'c1', company_name: 'Gone Co', days_inactive: null, last_login: null }]);
    expect(within(row).getAllByText('Never')).toHaveLength(2);
    expect(row.textContent).not.toMatch(/0d/);
  });
  it('signed in 20 days ago: 20d and a date', async () => {
    const row = await open([{ company_id: 'c1', company_name: 'Gone Co', days_inactive: 20, last_login: '2026-10-25T08:00:00Z' }]);
    expect(within(row).getByText('20d')).toBeTruthy();
    expect(within(row).queryByText('Never')).toBeNull();
  });
});
