/**
 * `CompanyProvider`'s `skipFetch` prop (Task 12 fix round 2).
 *
 * A PDF print render (Gotenberg) cannot have its background network calls
 * stubbed the way the Playwright transport stubs them. `CompanyProvider`'s
 * own `/api/accounting/companies` fetch is not one of the print token's
 * authorised paths, so under Gotenberg it 401s and `apiFetch`'s global
 * refresh-then-redirect (src/lib/apiFetch.ts) navigates the whole render to
 * `/login` before it can finish. `skipFetch` is the gate `_app.tsx` sets for
 * a print render so this provider makes no fetch at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: 'u1', role: 'owner' },
    loading: false,
  }),
}));

import { CompanyProvider, useCompany } from '@/contexts/CompanyContext';

function Probe() {
  const { activeCompany, companies, loading } = useCompany();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="company">{activeCompany?.id ?? 'none'}</span>
      <span data-testid="count">{companies.length}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('CompanyProvider skipFetch', () => {
  it('makes no fetch and settles into the empty state when skipFetch is true', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { getByTestId } = render(
      <CompanyProvider skipFetch>
        <Probe />
      </CompanyProvider>,
    );

    await waitFor(() => expect(getByTestId('loading').textContent).toBe('false'));
    expect(getByTestId('company').textContent).toBe('none');
    expect(getByTestId('count').textContent).toBe('0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does fetch when skipFetch is false (default) — the mutation this test would miss without the gate', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { items: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <CompanyProvider>
        <Probe />
      </CompanyProvider>,
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });
});
