// Admin user detail → Companies: a linked company's role changes inline
// (PATCH company-role), Remove asks for a Confirm that does not time out
// (2026-10-16: the old click-twice "Sure?" reverted after 3 s and sent
// nothing), and the server's refusal (last owner) is shown, never swallowed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'u-1' }, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
vi.mock('@/components/admin/users/UserAuditLog', () => ({ UserAuditLog: () => null }));
vi.mock('@/components/admin/users/UserProfileForm', () => ({ UserProfileForm: () => null }));
vi.mock('@/components/admin/users/LoginAsModal', () => ({ LoginAsModal: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import UserDetailPage from '../../../pages/admin/users/[id]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
const DEMO = '00000000-0000-0000-0000-000000000001';
const USER = { id: 'u-1', first_name: 'Synth', last_name: 'Admin', email: 'synth@example.test', phone: null, role: 'admin',
  status: 'active', last_login: null, login_count: 0, created_at: '2026-01-01T00:00:00Z', account_type: 'direct', bureaus: [],
  companies: [
    { company_id: DEMO, company_name: 'ISAFlow Demo', role: 'bookkeeper', is_default: true },
    { company_id: 'c-own', company_name: 'Owner Co', role: 'owner', is_default: false },
  ] };

function writes(method: string, part: string) {
  return vi.mocked(apiFetch).mock.calls.filter(([url, init]) =>
    String(url).includes(part) && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
}
async function openCompanies(...routes: Parameters<typeof serve>) {
  serve(...routes, on('GET', '/api/admin/users/u-1', () => ok(USER)), on('GET', '/api/admin/companies', () => ok({ items: [] })));
  render(<UserDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'companies' }));
  await screen.findByText('ISAFlow Demo');
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('admin user detail: linked company role', () => {
  it('changing the role and saving sends PATCH company-role with the company and role', async () => {
    await openCompanies(on('PATCH', '/company-role', () => ok({ role: 'accountant' })));
    fireEvent.change(screen.getByLabelText('Role in ISAFlow Demo'), { target: { value: 'accountant' } });
    fireEvent.click(screen.getByRole('button', { name: /Save role/ }));
    await waitFor(() => expect(writes('PATCH', '/api/admin/users/u-1/company-role')).toHaveLength(1));
    const init = writes('PATCH', '/company-role')[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ company_id: DEMO, role: 'accountant' });
    expect((init.headers as Record<string, string>)['X-Admin-Request']).toBe('true');
  });

  it("an owner's row shows Owner (not grantable) and offers only the portal roles; no Save until changed", async () => {
    await openCompanies();
    const select = screen.getByLabelText('Role in Owner Co') as HTMLSelectElement;
    expect(select.value).toBe('owner');
    const options = Array.from(select.options).map(o => [o.value, o.disabled]);
    expect(options).toEqual([['owner', true], ['admin', false], ['accountant', false], ['bookkeeper', false], ['viewer', false]]);
    expect(screen.queryByRole('button', { name: /Save role/ })).toBeNull();
  });

  it("the server's last-owner refusal is shown", async () => {
    await openCompanies(on('PATCH', '/company-role', () => refuse("Cannot change role: this is the company's last owner", 409)));
    fireEvent.change(screen.getByLabelText('Role in Owner Co'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /Save role/ }));
    expect(await screen.findByText(/last owner/)).toBeDefined();
  });
});

describe('admin user detail: remove a company link', () => {
  it('Remove asks to confirm, and the confirm does not time out (it used to revert after 3 s)', async () => {
    await openCompanies(on('DELETE', '/remove-from-company', () => ok({ removed: true })));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove$/ })[0]!);
    expect(writes('DELETE', '/remove-from-company')).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(writes('DELETE', '/api/admin/users/u-1/remove-from-company')).toHaveLength(1));
    const init = writes('DELETE', '/remove-from-company')[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ company_id: DEMO });
  });

  it('Cancel sends nothing', async () => {
    await openCompanies();
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove$/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm remove' })).toBeNull();
    expect(writes('DELETE', '/remove-from-company')).toHaveLength(0);
  });

  it("the server's refusal is shown, not a silent no-op", async () => {
    await openCompanies(on('DELETE', '/remove-from-company', () => refuse('Cannot remove the last owner of the company', 409)));
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove$/ })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(await screen.findByText('Cannot remove the last owner of the company')).toBeDefined();
  });
});
