/**
 * D2 (admin action sites): settings saves, user delete / impersonate, company suspend / activate / delete,
 * trial conversion, subscription cancel. The server's message from the real error envelope is shown to the
 * user, not the generic fallback. Real apiJson/assertOk run over a scripted apiFetch.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const refuse = (msg: string) => json({ success: false, error: { code: 'CONFLICT', message: msg } }, 409);

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

afterEach(() => { cleanup(); });

describe('admin settings saves show the server message', () => {
  const settingsRoute = (failPath: string, msg: string): Router => (p, m) => {
    if (p === '/api/admin/settings' && m === 'GET') return success({});
    if (p === '/api/admin/alert-settings' && m === 'GET') return success({ health_alert_email: '', health_alert_webhook_url: '' });
    if (p === failPath && m === 'PATCH') return refuse(msg);
    return null;
  };
  it('platform settings', async () => {
    const msg = 'D2 server says no: maintenance message is too long';
    script(settingsRoute('/api/admin/settings', msg));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^save settings$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
  it('alert settings', async () => {
    const msg = 'D2 server says no: webhook url must be https';
    script(settingsRoute('/api/admin/alert-settings', msg));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /save alert settings/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
});

describe('admin users', () => {
  it('list: delete refused', async () => {
    const msg = 'D2 server says no: user still owns company Acme';
    script((p, m) => {
      if (p === '/api/admin/users' && m === 'GET') return success({ items: [{ ...USER, company_count: 1, primary_company: 'Acme' }], total: 1, page: 1, limit: 25 });
      if (p === '/api/admin/users/x-1' && m === 'DELETE') return refuse(msg);
      return null;
    });
    render(<UsersPage />);
    fireEvent.click(await screen.findByTitle('Delete user'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
  it('detail: impersonate refused', async () => {
    const msg = 'D2 server says no: impersonation is disabled for this company';
    script((p, m) => {
      if (p === '/api/admin/users/x-1' && m === 'GET') return success(USER);
      if (p === '/api/admin/companies/co-9/impersonate') return refuse(msg);
      return null;
    });
    render(<UserDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^impersonate$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
});

describe('admin company detail', () => {
  const companyRoute = (status: string, failPath: string, failMethod: string, msg: string): Router => (p, m) => {
    if (p === '/api/admin/companies/x-1' && m === 'GET') return success({ ...COMPANY, status });
    if (p === failPath && m === failMethod) return refuse(msg);
    return null;
  };
  it('load refused', async () => {
    const msg = 'D2 server says no: company x-1 belongs to another region';
    script((p) => (p === '/api/admin/companies/x-1' ? json({ success: false, error: { code: 'FORBIDDEN', message: msg } }, 403) : null));
    render(<CompanyDetailPage />);
    expect(await screen.findByText(msg)).toBeTruthy();
  });
  it('suspend refused', async () => {
    const msg = 'D2 server says no: company has an open payment run';
    script(companyRoute('active', '/api/admin/companies/x-1/suspend', 'POST', msg));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^suspend$/i }));
    const suspend = screen.getAllByRole('button', { name: /^suspend$/i });
    fireEvent.click(suspend[suspend.length - 1]!);
    expect(await screen.findByText(msg)).toBeTruthy();
  });
  it('activate refused', async () => {
    const msg = 'D2 server says no: unpaid invoices block reactivation';
    script(companyRoute('suspended', '/api/admin/companies/x-1/activate', 'POST', msg));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^activate$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
  it('delete refused', async () => {
    const msg = 'D2 server says no: company has posted journals and cannot be deleted';
    script(companyRoute('active', '/api/admin/companies/x-1', 'DELETE', msg));
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
});

describe('admin billing components', () => {
  it('ConvertTrialModal: conversion refused', async () => {
    const msg = 'D2 server says no: trial already converted by another admin';
    script((p, m) => {
      if (p === '/api/admin/billing/plans') return success([{ id: 'p1', name: 'Starter', code: 'starter', monthly_price_cents: 100, currency: 'ZAR' }]);
      if (p === '/api/admin/trials/convert' && m === 'POST') return refuse(msg);
      return null;
    });
    render(<ConvertTrialModal companyId="x-1" companyName="Acme" onClose={() => undefined} onConverted={() => undefined} />);
    await screen.findByText('Starter');
    fireEvent.click(screen.getByRole('button', { name: /^convert to paid$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
  it('CompanyBillingTab: cancel refused', async () => {
    const msg = 'D2 server says no: subscription is locked by an open dispute';
    script((p, m) => {
      if (p === '/api/admin/billing/subscriptions') return success({ items: [SUB], total: 1 });
      if (p === '/api/admin/billing/subscriptions/sub-1' && m === 'PATCH') return refuse(msg);
      return null;
    });
    render(<CompanyBillingTab companyId="x-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /cancel subscription/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm cancel/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
});
