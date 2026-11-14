// Admin company detail (WP13, admin audit 2026-11-14):
//  - 4.6  the Users tab shows each user's name (the API sends `name`; the page read first_name/last_name);
//  - 4.17 a field blanked in Edit is sent as null so it clears (it used to be left out, keeping the old value).
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', asPath: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const COMPANY = { id: 'x-1', name: 'Acme Ltd', trading_name: null, registration_number: null, vat_number: null, email: null,
  phone: '011 555 0000', website: null, billing_email: null, billing_contact: null, address_line1: null, city: 'Pretoria',
  province: null, postal_code: null, plan_name: 'Starter', plan_code: 'starter', billing_cycle: 'monthly', status: 'active',
  user_count: 1, mrr_cents: 0, created_at: '2026-01-01T00:00:00Z', last_active: null };

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const p = String(url).split('?')[0]!;
    if (p === '/api/admin/companies/x-1' && init?.method === 'PATCH') return ok({ ...COMPANY, phone: null });
    if (p === '/api/admin/companies/x-1') return ok(COMPANY);
    if (p === '/api/admin/companies/x-1/users') return ok([{ id: 'u1', name: 'Lerato Mokoena', email: 'lerato@acme.test', role: 'admin', last_login: null }]);
    return ok([]);
  });
});
afterEach(() => { cleanup(); });

describe('company detail', () => {
  it('Users tab shows the user name', async () => {
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^users$/i }));
    expect(await screen.findByText('Lerato Mokoena')).toBeTruthy();
  });

  it('a blanked field is sent as null; untouched fields keep their value', async () => {
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(await screen.findByLabelText('Phone'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
    const [, init] = vi.mocked(apiFetch).mock.calls.find(([, i]) => i?.method === 'PATCH')!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.phone).toBeNull();
    expect(body.city).toBe('Pretoria');
    expect(body.name).toBe('Acme Ltd');
  });
});
