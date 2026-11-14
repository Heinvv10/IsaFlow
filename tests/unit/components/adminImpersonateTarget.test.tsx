/**
 * Admin audit 2026-11-14, item 4.9: "Impersonate" opened a relative /accounting?impersonate=..., which on
 * admin.isaflow.co.za is rewritten to /admin/accounting (a 404). The tab must open the tenant app's /accounting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import UserDetailPage from '../../../pages/admin/users/[id]';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';

useApiJsonOverMock();

const START_URL = window.location.href;
const onHost = (url: string) => (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
const success = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

const USER = { id: 'x-1', first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com', phone: null, role: 'admin', status: 'active',
  last_login: null, login_count: 0, created_at: '2026-01-01T00:00:00Z', account_type: 'direct', bureaus: [],
  companies: [{ company_id: 'co-9', company_name: 'Acme', role: 'admin', is_default: true }] };
const COMPANY = { id: 'x-1', name: 'Acme Ltd', trading_name: null, registration_number: null, vat_number: null, email: null,
  phone: null, website: null, billing_email: null, billing_contact: null, address_line1: null, city: null, province: null,
  postal_code: null, plan_name: 'Starter', billing_cycle: 'monthly', status: 'active', created_at: '2026-01-01T00:00:00Z', last_active: null };

let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  open = vi.fn();
  vi.stubGlobal('open', open);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const p = String(url).split('?')[0]!;
    if (p === '/api/admin/users/x-1') return success(USER);
    if (p === '/api/admin/companies/x-1') return success(COMPANY);
    if (p === '/api/admin/users/x-1/impersonate') return success({ redirect: '/accounting' });
    if (p.endsWith('/impersonate')) return success({ token: 'tok 1' });
    return success([]);
  });
});
afterEach(() => { cleanup(); onHost(START_URL); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function impersonateFromUser() {
  render(<UserDetailPage />);
  expect((await screen.findAllByText(/Ann Lee/)).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: /^impersonate$/i }));
}
async function impersonateFromCompany() {
  render(<CompanyDetailPage />);
  expect((await screen.findAllByText('Acme Ltd')).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: /^impersonate$/i }));
}

async function loginAs() {
  render(<UserDetailPage />);
  expect((await screen.findAllByText(/Ann Lee/)).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: /login as/i }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm & login as/i }));
  fireEvent.click(await screen.findByRole('button', { name: /open impersonated session/i }));
}

describe('Login As opens the tenant app through the same rule', () => {
  it('on the admin host with no NEXT_PUBLIC_APP_URL: app.isaflow.co.za', async () => {
    onHost('https://admin.isaflow.co.za/users/x-1');
    await loginAs();
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://app.isaflow.co.za/accounting', '_blank', 'noopener,noreferrer'));
  });

  it('in dev (/admin/* on the app origin): this origin, not production', async () => {
    onHost('http://localhost:3200/admin/users/x-1');
    await loginAs();
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://localhost:3200/accounting', '_blank', 'noopener,noreferrer'));
  });
});

describe('Impersonate opens the tenant app', () => {
  it('user detail on the admin host opens app.isaflow.co.za/accounting, not the admin host', async () => {
    onHost('https://admin.isaflow.co.za/users/x-1');
    await impersonateFromUser();
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://app.isaflow.co.za/accounting?impersonate=tok%201', '_blank', 'noopener,noreferrer'));
  });

  it('user detail uses NEXT_PUBLIC_APP_URL when it is set', async () => {
    onHost('https://admin.isaflow.co.za/users/x-1');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/');
    await impersonateFromUser();
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://app.example.test/accounting?impersonate=tok%201', '_blank', 'noopener,noreferrer'));
  });

  it('user detail off the admin host (dev, /admin/*) stays on this origin', async () => {
    onHost('http://localhost:3200/admin/users/x-1');
    await impersonateFromUser();
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://localhost:3200/accounting?impersonate=tok%201', '_blank', 'noopener,noreferrer'));
  });

  it('company detail on the admin host with no NEXT_PUBLIC_APP_URL opens the tenant app too', async () => {
    onHost('https://admin.isaflow.co.za/companies/x-1');
    await impersonateFromCompany();
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://app.isaflow.co.za/accounting?impersonate=tok%201', '_blank', 'noopener,noreferrer'));
  });
});
