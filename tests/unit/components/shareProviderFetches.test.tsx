/**
 * The public share page fetches nothing that needs a session.
 *
 * A share link is opened by a third party with no cookie. `AuthProvider` calls
 * `/api/auth/me` on mount and `CompanyProvider` calls
 * `/api/accounting/companies`; both 401 there, and `apiFetch`'s global
 * refresh-then-redirect is what turns a 401 into a navigation to `/login`. The
 * recipient of a valid link would watch the pack they were sent replaced by a
 * login screen they have no account for.
 *
 * The same `skipFetch` props WS2 added for the print render carry this: a
 * print render and a share page are the two routes with no session to fetch.
 * Rendered, not grepped — the gate is a branch inside each provider's mount
 * effect, and only a mounted tree exercises it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, screen, act } from '@testing-library/react';

let pathname = '/accounting/reports/report-packs';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname, isReady: true, query: {}, events: { on: () => {}, off: () => {} } }),
}));
vi.mock('@/components/analytics/TrackerScript', () => ({ TrackerScript: () => null }));

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
}));

/** Every URL the tree asked for, however it asked. */
const asked = () => fetchMock.mock.calls.map(c => String(c[0]));

async function mount() {
  const { default: App } = await import('../../../pages/_app');
  render(
    React.createElement(App, {
      Component: () => React.createElement('main', null, 'shared pack'),
      pageProps: {},
      router: {} as never,
    } as never),
  );
}

// The first import of pages/_app is slow under a loaded machine; the 5 s default failed pre-push gates. Timing only.
const LOAD_TIMEOUT = 60_000;

describe('pages/_app.tsx — provider fetches on the public share page', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches the session on an ordinary app page', async () => {
    pathname = '/accounting/reports/report-packs';
    await mount();
    await waitFor(() => expect(asked().some(u => u.includes('/api/auth/me'))).toBe(true), { timeout: 15_000 });
  }, LOAD_TIMEOUT);

  it('fetches neither the session nor the companies on a share route', async () => {
    pathname = '/share/[token]';
    await mount();
    // App has mounted (its page text is on screen), and both fetches, which live in mount effects, get
    // 400 ms to be wrong in: a bare setTimeout(0) after a slow import would pass without checking anything.
    expect(await screen.findByText('shared pack')).toBeTruthy();
    await act(async () => { await new Promise(r => setTimeout(r, 400)); });
    expect(asked().some(u => u.includes('/api/auth/me'))).toBe(false);
    expect(asked().some(u => u.includes('/api/accounting/companies'))).toBe(false);
  }, LOAD_TIMEOUT);
});
