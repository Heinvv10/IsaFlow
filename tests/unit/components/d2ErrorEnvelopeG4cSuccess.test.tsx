/**
 * D2 success paths for the admin action sites in d2ErrorEnvelopeG4c: a 200 success envelope completes the action
 * (success text, reload, callback). NOT COVERED: company delete (success only calls router.push, not observable here).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SettingsPage from '../../../pages/admin/settings';
import UsersPage from '../../../pages/admin/users/index';
import UserDetailPage from '../../../pages/admin/users/[id]';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';
import { ConvertTrialModal } from '@/components/admin/ConvertTrialModal';
import { CompanyBillingTab } from '@/components/admin/companies/CompanyBillingTab';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const success = (data: unknown) => json({ success: true, data });

type Router = (path: string, method: string) => Response | null;
function script(route: Router) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) =>
    route(String(url).split('?')[0]!, init?.method ?? 'GET') ?? success([]));
}

const COMPANY = { id: 'x-1', name: 'Acme Ltd', trading_name: null, registration_number: null, vat_number: null, email: null,
  phone: null, website: null, billing_email: null, billing_contact: null, address_line1: null, city: null, province: null,
  postal_code: null, plan_name: 'Starter', billing_cycle: 'monthly', status: 'active', created_at: '2026-01-01T00:00:00Z', last_active: null };
const SUB = { id: 'sub-1', company_id: 'x-1', company_name: 'Acme Ltd', plan_id: 'p1', plan_name: 'Starter', plan_code: 'starter',
  status: 'active', billing_cycle: 'monthly', current_period_start: null, current_period_end: null, cancel_at_period_end: false,
  discount_percent: 0, monthly_amount_cents: 100, created_at: '2026-01-01T00:00:00Z' };
const USER = { id: 'x-1', first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com', phone: null, role: 'admin', status: 'active',
  last_login: null, login_count: 0, created_at: '2026-01-01T00:00:00Z', account_type: 'direct', bureaus: [],
  companies: [{ company_id: 'co-9', company_name: 'Acme', role: 'admin', is_default: true }] };


const calls = (p: string, m: string) => vi.mocked(apiFetch).mock.calls.filter(([u, i]) =>
  String(u).split('?')[0] === p && ((i as RequestInit | undefined)?.method ?? 'GET') === m).length;

afterEach(() => { cleanup(); });

describe('admin action sites complete on a success envelope', () => {
  const settingsRoute: Router = (p, m) => {
    if (p === '/api/admin/settings' && m === 'GET') return success({});
    if (p === '/api/admin/alert-settings' && m === 'GET') return success({ health_alert_email: '', health_alert_webhook_url: '' });
    return null;
  };
  it('success: settings platform save completes', async () => {
    script(settingsRoute);
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^save settings$/i }));
    expect(await screen.findByText('Settings saved successfully.')).toBeTruthy();
  });
  it('success: settings alert save completes', async () => {
    script(settingsRoute);
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /save alert settings/i }));
    expect(await screen.findByText('Alert settings saved.')).toBeTruthy();
  });

  it('success: users list renders the data it received and delete completes', async () => {
    let deleted = false;
    script((p, m) => {
      if (p === '/api/admin/users' && m === 'GET') {
        return success({ items: deleted ? [] : [{ ...USER, first_name: 'Zelda', last_name: 'Quimby', company_count: 1, primary_company: 'Acme' }], total: 1, page: 1, limit: 25 });
      }
      if (p === '/api/admin/users/x-1' && m === 'DELETE') { deleted = true; return success({}); }
      return null;
    });
    render(<UsersPage />);
    expect(await screen.findByText(/Zelda Quimby/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Delete user'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByText(/Zelda Quimby/)).toBeNull());
  });
  it('success: user detail renders the data it received and impersonate completes', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    script((p, m) => {
      if (p === '/api/admin/users/x-1' && m === 'GET') return success({ ...USER, first_name: 'Yvonne', last_name: 'Zuma' });
      if (p === '/api/admin/companies/co-9/impersonate') return success({ token: 'tok-123' });
      return null;
    });
    render(<UserDetailPage />);
    expect((await screen.findAllByText(/Yvonne Zuma/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^impersonate$/i }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('/accounting?impersonate=tok-123', '_blank'));
  });
});

describe('admin company detail completes on a success envelope', () => {
  it('success: company detail renders the data it received and suspend completes', async () => {
    let suspended = false;
    script((p, m) => {
      if (p === '/api/admin/companies/x-1' && m === 'GET') return success({ ...COMPANY, name: 'Pelican Traders', status: suspended ? 'suspended' : 'active' });
      if (p === '/api/admin/companies/x-1/suspend' && m === 'POST') { suspended = true; return success({}); }
      return null;
    });
    render(<CompanyDetailPage />);
    expect((await screen.findAllByText('Pelican Traders')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^suspend$/i }));
    const suspend = screen.getAllByRole('button', { name: /^suspend$/i });
    fireEvent.click(suspend[suspend.length - 1]!);
    expect(await screen.findByRole('button', { name: /^activate$/i })).toBeTruthy();
  });
});

describe('admin billing components complete on a success envelope', () => {
  it('success: ConvertTrialModal conversion completes', async () => {
    const onConverted = vi.fn();
    script((p, m) => {
      if (p === '/api/admin/billing/plans') return success([{ id: 'p1', name: 'Starter', code: 'starter', monthly_price_cents: 100, currency: 'ZAR' }]);
      if (p === '/api/admin/trials/convert' && m === 'POST') return success({});
      return null;
    });
    render(<ConvertTrialModal companyId="x-1" companyName="Acme" onClose={() => undefined} onConverted={onConverted} />);
    await screen.findByText('Starter');
    fireEvent.click(screen.getByRole('button', { name: /^convert to paid$/i }));
    await waitFor(() => expect(onConverted).toHaveBeenCalledTimes(1));
  });
  it('success: CompanyBillingTab cancel completes', async () => {
    script((p, m) => {
      if (p === '/api/admin/billing/subscriptions') return success({ items: [{ ...SUB, plan_name: 'Kraken Plan' }], total: 1 });
      if (p === '/api/admin/billing/subscriptions/sub-1' && m === 'PATCH') return success({});
      return null;
    });
    render(<CompanyBillingTab companyId="x-1" />);
    expect((await screen.findAllByText(/Kraken Plan/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /cancel subscription/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm cancel/i }));
    await waitFor(() => expect(calls('/api/admin/billing/subscriptions', 'GET')).toBe(2));
    expect(screen.queryByRole('button', { name: /confirm cancel/i })).toBeNull();
  });
});
