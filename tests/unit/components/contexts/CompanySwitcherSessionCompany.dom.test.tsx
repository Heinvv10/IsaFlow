/**
 * R-148: the company switcher must name the company the SERVER session serves.
 *
 * `withAuth` scopes every API call by the `active_company_id` cookie. The
 * provider used to activate whatever `localStorage` held, so a cookie of A
 * with a stored B put B's name over A's data. The user-companies response now
 * carries the company `withAuth` resolved for the request (`activeCompanyId`);
 * the provider must activate that one and correct `localStorage` to it.
 *
 * Only the network boundary (global fetch) is mocked; CompanyProvider and
 * CompanySwitcher run for real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: 'u1', role: 'accountant' }, loading: false }),
}));

import { CompanyProvider, useCompany } from '@/contexts/CompanyContext';
import { CompanySwitcher } from '@/components/layout/CompanySwitcher';
import { COMPANY_STORAGE_KEY } from '@/contexts/companyModel';

const A = { id: '00000000-0000-0000-0000-00000000000a', name: 'Alpha Holdings' };
const B = { id: '00000000-0000-0000-0000-00000000000b', name: 'Bravo Trading' };
const BY_ID: Record<string, { id: string; name: string }> = { [A.id]: A, [B.id]: B };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** The server: a member of A and B (B is the stored default), serving `sessionCompanyId`. */
function stubServer(sessionCompanyId: string, { detailsFail = false } = {}) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/accounting/companies' && url.searchParams.get('action') === 'user-companies') {
      return json({
        success: true,
        data: {
          items: [
            { companyId: A.id, companyName: A.name, role: 'owner', isDefault: false },
            { companyId: B.id, companyName: B.name, role: 'owner', isDefault: true },
          ],
          activeCompanyId: sessionCompanyId,
        },
      });
    }
    const id = url.searchParams.get('id');
    if (url.pathname === '/api/accounting/companies' && id && BY_ID[id]) {
      if (detailsFail) return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
      return json({ success: true, data: BY_ID[id] });
    }
    throw new Error(`unexpected fetch ${url.pathname}${url.search}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function storeCompany(c: { id: string; name: string }) {
  window.localStorage.setItem(COMPANY_STORAGE_KEY, JSON.stringify({ id: c.id, name: c.name, isDemo: false }));
}

function LoadingProbe() {
  return <span data-testid="loading">{String(useCompany().loading)}</span>;
}

function renderSwitcher() {
  return render(
    <CompanyProvider>
      <CompanySwitcher />
      <LoadingProbe />
    </CompanyProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('CompanySwitcher names the company the server session serves (R-148)', () => {
  it('server serves A, localStorage says B: the label shows A and localStorage is corrected to A', async () => {
    const fetchSpy = stubServer(A.id);
    storeCompany(B);

    renderSwitcher();

    await waitFor(() => expect(screen.getByRole('button').textContent).toContain(A.name));
    expect(screen.getByRole('button').textContent).not.toContain(B.name);
    expect(JSON.parse(window.localStorage.getItem(COMPANY_STORAGE_KEY)!).id).toBe(A.id);
    // Trust the server, never move it: no switch-company POST on mount.
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some(u => u.includes('/api/auth/switch-company'))).toBe(false);
  });

  it('server serves A, localStorage says A: the label shows A', async () => {
    stubServer(A.id);
    storeCompany(A);

    renderSwitcher();

    await waitFor(() => expect(screen.getByRole('button').textContent).toContain(A.name));
    expect(JSON.parse(window.localStorage.getItem(COMPANY_STORAGE_KEY)!).id).toBe(A.id);
  });

  it('server serves B, localStorage says A: the label follows the server and shows B', async () => {
    stubServer(B.id);
    storeCompany(A);

    renderSwitcher();

    await waitFor(() => expect(screen.getByRole('button').textContent).toContain(B.name));
    expect(screen.getByRole('button').textContent).not.toContain(A.name);
    expect(JSON.parse(window.localStorage.getItem(COMPANY_STORAGE_KEY)!).id).toBe(B.id);
  });

  it('server serves A, localStorage says B, A\'s details fail to load: B\'s stored name is not left on screen', async () => {
    const fetchSpy = stubServer(A.id, { detailsFail: true });
    storeCompany(B);

    renderSwitcher();

    await waitFor(() => expect(fetchSpy.mock.calls.some(([u]) => String(u).includes(`id=${A.id}`))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toContain(B.name);
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBeNull();
  });

  it('server serves A, nothing stored: the label shows A, not the stored default B', async () => {
    stubServer(A.id);

    renderSwitcher();

    await waitFor(() => expect(screen.getByRole('button').textContent).toContain(A.name));
  });
});
