/**
 * `AuthProvider`'s `skipFetch` prop (Task 12 fix round 3).
 *
 * A PDF print render (Gotenberg) cannot have its background network calls
 * stubbed the way the Playwright transport stubs them. `AuthProvider`'s own
 * `/api/auth/me` fetch fails JWT verification on a print token and its
 * handler (withUserAuth) clears the sb-access-token cookie — the SAME
 * cookie carrying the print token — poisoning every later request in the
 * render. `skipFetch` is the gate `_app.tsx` sets for a print render so this
 * provider makes no fetch at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

function Probe() {
  const { user, isAuthenticated, loading } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="user">{user?.id ?? 'none'}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuthProvider skipFetch', () => {
  it('makes no fetch and settles into the unauthenticated empty state when skipFetch is true', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { getByTestId } = render(
      <AuthProvider skipFetch>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(getByTestId('loading').textContent).toBe('false'));
    expect(getByTestId('authenticated').textContent).toBe('false');
    expect(getByTestId('user').textContent).toBe('none');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does fetch /api/auth/me when skipFetch is false (default) — the mutation this test would miss without the gate', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { user: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/auth/me');
  });
});
