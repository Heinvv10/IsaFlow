// A deleted company can be found and restored from the admin platform: the
// list's Deleted filter asks the API for status=deleted, and a deleted company
// offers Restore (POST /restore) where an active one offers Suspend.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import CompaniesPage from '../../../pages/admin/companies/index';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const COMPANY = { id: 'x-1', name: 'Restore Acme Ltd', trading_name: null, registration_number: null, vat_number: null, email: null, phone: null,
  website: null, billing_email: null, billing_contact: null, address_line1: null, city: null, province: null, postal_code: null,
  plan_name: 'Starter', plan_code: 'starter', billing_cycle: 'monthly', user_count: 1, mrr_cents: 0, created_at: '2026-01-01T00:00:00Z', last_active: null };

function serve(status: string) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const p = String(url).split('?')[0]!;
    if (p === '/api/admin/companies/x-1') return ok({ ...COMPANY, status });
    if (p === '/api/admin/companies') return ok({ items: [{ ...COMPANY, status }], total: 1, page: 1, limit: 25 });
    return ok([]);
  });
}
const posted = (path: string) => vi.mocked(apiFetch).mock.calls.some(([u, i]) => String(u) === path && i?.method === 'POST');

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('admin company detail', () => {
  it('offers Restore, not Suspend, for a deleted company and posts to /restore', async () => {
    serve('deleted');
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^restore$/i }));
    expect(screen.queryByRole('button', { name: /^suspend$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    await waitFor(() => expect(posted('/api/admin/companies/x-1/restore')).toBe(true));
    expect(posted('/api/admin/companies/x-1/activate')).toBe(false);
  });

  it('still activates (not restores) a suspended company', async () => {
    serve('suspended');
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(posted('/api/admin/companies/x-1/activate')).toBe(true));
    expect(posted('/api/admin/companies/x-1/restore')).toBe(false);
  });
});

describe('admin companies list', () => {
  it('the Deleted filter asks the API for deleted companies', async () => {
    serve('active');
    render(<CompaniesPage />);
    fireEvent.change(await screen.findByDisplayValue('All statuses'), { target: { value: 'deleted' } });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).startsWith('/api/admin/companies?') && String(u).includes('status=deleted'))).toBe(true));
  });

  it('a deleted row restores through /restore', async () => {
    serve('deleted');
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByTitle('Restore'));
    await waitFor(() => expect(posted('/api/admin/companies/x-1/restore')).toBe(true));
    expect(screen.queryByTitle('Suspend')).toBeNull();
  });
});
