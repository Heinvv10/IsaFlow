/**
 * D2 round 3 (a7): CompanyProvider.switchCompany on the REAL apiFetch over a stubbed fetch. A failed switch is
 * reported to the caller (message, never a parse error) and keeps the old role; a good one applies the new role.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const authState = vi.hoisted(() => ({ value: { isAuthenticated: true, user: { id: 'u1', role: 'owner' }, loading: false } }));
const MSG = 'D2 server says no: not allowed';
const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const stubFetch = (fn: (url: string, init?: RequestInit) => Response) => vi.stubGlobal('fetch', vi.fn(async (u: unknown, i?: RequestInit) => fn(String(u), i)));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState.value }));
import { CompanyProvider, useCompany } from '@/contexts/CompanyContext';

describe('CompanyProvider.switchCompany', () => {
  const MEMBERS = { items: [{ companyId: 'co-1', companyName: 'One', role: 'owner' }, { companyId: 'co-2', companyName: 'Two', role: 'viewer' }], activeCompanyId: 'co-1' };
  function CoProbe() {
    const { companyRole, switchCompany, companies, loading } = useCompany();
    return (
      <div>
        <span data-testid="role">{companyRole ?? 'none'}</span><span data-testid="n">{companies.length}</span><span data-testid="loading">{String(loading)}</span>
        <button onClick={() => { void switchCompany('co-2').catch((e: Error) => { document.body.setAttribute('data-switch-error', e.message); }); }}>go two</button>
      </div>
    );
  }
  const run = async (sw: () => Response) => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, href: '', search: '' });
    stubFetch(u => (u.includes('user-companies') ? json(200, { success: true, data: MEMBERS }) : u.includes('switch-company') ? sw() : u.includes('/companies?id=') ? json(200, { data: { id: 'co-1', name: 'One' } }) : json(200, { success: true, data: {} })));
    render(<CompanyProvider><CoProbe /></CompanyProvider>);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('2'));
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    const roleBefore = screen.getByTestId('role').textContent;
    fireEvent.click(screen.getByRole('button', { name: 'go two' }));
    return { reload, roleBefore };
  };
  it('400: the caller gets the server message, the old role stays, no reload, loading clears', async () => {
    const { reload, roleBefore } = await run(() => json(403, { success: false, error: { code: 'FORBIDDEN', message: MSG } }));
    await waitFor(() => expect(document.body.getAttribute('data-switch-error')).toBe(MSG));
    expect(screen.getByTestId('role').textContent).toBe(roleBefore); expect(roleBefore).not.toBe('viewer');
    expect(reload).not.toHaveBeenCalled(); expect(screen.getByTestId('loading').textContent).toBe('false');
    document.body.removeAttribute('data-switch-error');
  });
  it('empty-body 500: a plain sentence', async () => {
    await run(() => json(500, ''));
    await waitFor(() => expect(document.body.getAttribute('data-switch-error')).toBe('Could not switch company - try again'));
    document.body.removeAttribute('data-switch-error');
  });
  it('200: the new role is applied and the page reloads', async () => {
    const { reload } = await run(() => json(200, { success: true, data: {} }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.getByTestId('role').textContent).toBe('viewer');
  });
});
