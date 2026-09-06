/**
 * `_app.tsx`'s `skipFetch` on CompanyProvider specifically.
 *
 * Its sibling file (appPrintProviderGate.dom.test.tsx) cannot pin this prop on
 * its own: with AuthProvider correctly skipped, CompanyProvider never gets an
 * authenticated user and so makes no request either way, and dropping the prop
 * stays green. AuthContext is stubbed here as permanently authenticated, so
 * the only thing standing between a print render and
 * `/api/accounting/companies` is the prop under test.
 *
 * What that fetch costs if it fires: the path is not one the print token
 * authorises, so it 401s, and apiFetch's global refresh-then-redirect
 * navigates the whole render to /login before the pack can finish.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { NextRouter } from 'next/router';
import { PRINT_RENDER_PATH } from '@/lib/pdf/printRenderQuery';

const routerState = { pathname: PRINT_RENDER_PATH, query: {} as Record<string, unknown>, isReady: true };

vi.mock('next/router', () => ({
  useRouter: () => ({
    ...routerState,
    asPath: routerState.pathname,
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(),
  } as unknown as NextRouter),
}));

vi.mock('next/script', () => ({ default: () => null }));
vi.mock('react-hot-toast', () => ({ Toaster: () => null }));

// An AuthProvider that is authenticated no matter what _app passes it. This is
// what makes CompanyProvider's own gate the only variable in the test.
vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    isAuthenticated: true,
    loading: false,
    user: { id: 'u1', email: 'u@example.com', role: 'owner' },
  }),
}));

import App from '@/../pages/_app';

const calledPaths: string[] = [];

beforeEach(() => {
  calledPaths.length = 0;
  routerState.pathname = PRINT_RENDER_PATH;
  routerState.query = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calledPaths.push(new URL(String(url), 'http://localhost').pathname);
    return new Response(JSON.stringify({ success: true, data: { items: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const Page = () => <div data-testid="page">page</div>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderApp = () => render(<App Component={Page as any} pageProps={{}} router={{} as any} />);

describe('_app print gate — CompanyProvider', () => {
  it('fetches the company list on an ordinary navigation', async () => {
    renderApp();
    await waitFor(() => expect(calledPaths.some(p => p.startsWith('/api/accounting/companies'))).toBe(true));
  });

  it('fetches nothing during a print render, even with an authenticated user', async () => {
    routerState.query = { print: '1' };
    const { queryByTestId } = renderApp();
    await waitFor(() => expect(queryByTestId('page')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(calledPaths).toEqual([]);
  });
});
