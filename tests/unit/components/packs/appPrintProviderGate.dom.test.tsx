/**
 * `_app.tsx`'s print gate, at the level it actually runs.
 *
 * `skipFetch={printRender}` is passed to both providers and the tracker is
 * gated on the same flag, and none of that was pinned: dropping one prop
 * compiles, and the failure only shows up as a PDF that redirected to /login
 * or an analytics feed full of synthetic pageviews.
 *
 * What each provider's fetch costs during a render, if it fires:
 *   AuthProvider → /api/auth/me, whose withUserAuth CLEARS the sb-access-token
 *     cookie on a print token — the cookie carrying that token.
 *   CompanyProvider → /api/accounting/companies, unauthorised by the token, so
 *     it 401s and apiFetch's global redirect navigates the render to /login.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
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

// next/script would try to inject a real <script>; the assertion is only
// whether the tracker rendered at all.
vi.mock('next/script', () => ({ default: (p: Record<string, unknown>) => <div data-testid="tracker" data-src={String(p.src)} /> }));
vi.mock('react-hot-toast', () => ({ Toaster: () => null }));

import App from '@/../pages/_app';

const calledPaths: string[] = [];

beforeEach(() => {
  calledPaths.length = 0;
  routerState.pathname = PRINT_RENDER_PATH;
  routerState.query = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const { pathname } = new URL(String(url), 'http://localhost');
    calledPaths.push(pathname);
    // A real user, so CompanyProvider's own fetch is reached on the
    // non-print path — otherwise the control case passes for the wrong reason.
    const data = pathname === '/api/auth/me'
      ? { user: { id: 'u1', email: 'u@example.com', firstName: 'U', lastName: 'One', name: 'U One', role: 'owner', permissions: [], isActive: true } }
      : { items: [] };
    return new Response(JSON.stringify({ success: true, data }), {
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

/** Both providers fire on mount, so one turn of the event loop is enough. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('_app print gate — a print render fetches nothing from the providers', () => {
  it('fires neither /api/auth/me nor /api/accounting/companies', async () => {
    routerState.query = { print: '1' };
    renderApp();
    await waitFor(() => expect(document.querySelector('[data-testid="page"]')).not.toBeNull());
    await settle();

    expect(calledPaths).not.toContain('/api/auth/me');
    expect(calledPaths.some(p => p.startsWith('/api/accounting/companies'))).toBe(false);
    expect(calledPaths).toEqual([]);
  });

  it('does not mount the analytics tracker, so an export is not a pageview', async () => {
    // The tracker resolves its id in a mount effect, so a bare assertion would
    // pass simply by looking too early. The control render below establishes
    // that this wait is long enough for the tracker to appear when it should.
    routerState.query = {};
    const control = renderApp();
    await waitFor(() => expect(control.queryByTestId('tracker')).not.toBeNull());
    cleanup();

    calledPaths.length = 0;
    routerState.query = { print: '1' };
    const printed = renderApp();
    await waitFor(() => expect(printed.queryByTestId('page')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(printed.queryByTestId('tracker')).toBeNull();
  });
});

describe('_app print gate — an ordinary navigation is untouched', () => {
  it('still fetches the auth and company context', async () => {
    renderApp();
    await waitFor(() => expect(calledPaths).toContain('/api/auth/me'));
    await waitFor(() => expect(calledPaths.some(p => p.startsWith('/api/accounting/companies'))).toBe(true));
  });

  it('still mounts the analytics tracker', async () => {
    const { queryByTestId } = renderApp();
    await waitFor(() => expect(queryByTestId('tracker')).not.toBeNull());
  });

  it('another page carrying ?print=1 is NOT a print render', async () => {
    routerState.pathname = '/accounting/invoices';
    routerState.query = { print: '1' };
    renderApp();
    await waitFor(() => expect(calledPaths).toContain('/api/auth/me'));
  });
});
