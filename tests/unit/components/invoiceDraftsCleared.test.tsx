/**
 * Master plan wave 3, PR S: every `isaflow:invoice-draft:*` key goes on sign-out, on a session that expired (every
 * redirect to /login runs clearTenantClientState), and on a company switch, so the next
 * person at this browser, or the next company, is never offered another's invoice. Other keys stay. A switch the
 * server refused leaves the user where they were, drafts included.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearInvoiceDrafts, invoiceDraftKey } from '@/lib/invoiceDrafts';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const authState = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/contexts/AuthContext', async (orig) => {
  const real = await orig<typeof import('@/contexts/AuthContext')>();
  return { ...real, useAuth: () => authState.value ?? real.useAuth() };
});

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { CompanyProvider, useCompany } from '@/contexts/CompanyContext';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const stubFetch = (fn: (url: string) => Response) => vi.stubGlobal('fetch', vi.fn(async (u: unknown) => fn(String(u))));
const plant = () => {
  localStorage.setItem(invoiceDraftKey('co-1', 'u1'), '{"savedAt":1,"data":{}}');
  localStorage.setItem(invoiceDraftKey('co-2', 'u2'), '{"savedAt":1,"data":{}}');
  localStorage.setItem('isaflow_theme', 'dark');
};
const drafts = () => Object.keys(localStorage).filter((k) => k.startsWith('isaflow:invoice-draft:'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); authState.value = null; });

describe('clearInvoiceDrafts', () => {
  it('removes every invoice draft and nothing else', () => {
    plant();
    expect(clearInvoiceDrafts()).toBe(true);
    expect(drafts()).toEqual([]);
    expect(localStorage.getItem('isaflow_theme')).toBe('dark');
  });

  it('a storage that throws is reported, not raised', () => {
    const key = vi.spyOn(localStorage, 'key').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    plant();
    expect(clearInvoiceDrafts()).toBe(false);
    key.mockRestore();
  });
});

describe('sign-out', () => {
  function Probe() {
    const { user, logout } = useAuth();
    return <div><span data-testid="who">{user?.id ?? 'nobody'}</span><button onClick={() => { void logout(); }}>sign out</button></div>;
  }
  it('logout clears the invoice drafts', async () => {
    vi.stubGlobal('location', { ...window.location, href: '' });
    stubFetch((u) => (u === '/api/auth/me' ? json(200, { success: true, data: { user: { id: 'u1', email: 'a@b.c', role: 'owner' } } }) : json(200, {})));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('u1'));
    plant();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'sign out' })); });
    await waitFor(() => expect(drafts()).toEqual([]));
    expect(localStorage.getItem('isaflow_theme')).toBe('dark');
  });
});

describe('session expiry', () => {
  it('a refused session refresh, on its way to /login, clears the invoice drafts', async () => {
    const location = { ...window.location, pathname: '/accounting/customer-invoices/new', href: '/accounting/customer-invoices/new' };
    vi.stubGlobal('location', location);
    stubFetch(() => json(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'expired' } }));
    plant();
    const res = await apiFetch('/api/accounting/customers');
    expect(res.status).toBe(401);
    expect(location.href).toBe('/login?reason=session-expired');
    expect(drafts()).toEqual([]);
    expect(localStorage.getItem('isaflow_theme')).toBe('dark');
  });
});

describe('company switch', () => {
  const MEMBERS = { items: [{ companyId: 'co-1', companyName: 'One', role: 'owner' }, { companyId: 'co-2', companyName: 'Two', role: 'owner' }], activeCompanyId: 'co-1' };
  function Probe() {
    const { switchCompany, companies, loading } = useCompany();
    return (
      <div>
        <span data-testid="n">{companies.length}</span><span data-testid="loading">{String(loading)}</span>
        <button onClick={() => { void switchCompany('co-2').catch(() => document.body.setAttribute('data-refused', '1')); }}>go two</button>
      </div>
    );
  }
  const run = async (switchAnswer: () => Response) => {
    authState.value = { isAuthenticated: true, user: { id: 'u1', role: 'owner' }, loading: false };
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, href: '', search: '' });
    stubFetch((u) => (u.includes('user-companies') ? json(200, { success: true, data: MEMBERS })
      : u.includes('switch-company') ? switchAnswer()
        : u.includes('/companies?id=') ? json(200, { data: { id: 'co-1', name: 'One' } }) : json(200, { success: true, data: {} })));
    render(<CompanyProvider><Probe /></CompanyProvider>);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('2'));
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    plant();
    fireEvent.click(screen.getByRole('button', { name: 'go two' }));
    return reload;
  };

  it('a switch clears the invoice drafts', async () => {
    const reload = await run(() => json(200, { success: true, data: {} }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(drafts()).toEqual([]);
    expect(localStorage.getItem('isaflow_theme')).toBe('dark');
  });

  it('a switch the server refused keeps them', async () => {
    await run(() => json(403, { success: false, error: { code: 'FORBIDDEN', message: 'no' } }));
    await waitFor(() => expect(document.body.getAttribute('data-refused')).toBe('1'));
    document.body.removeAttribute('data-refused');
    expect(drafts()).toHaveLength(2);
  });
});
