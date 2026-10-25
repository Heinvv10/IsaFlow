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
import { render, screen, act } from '@testing-library/react';

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

/**
 * Yield `n` whole event-loop turns inside act(). Counted, not timed: how many turns the mount effects and their
 * fetches get is the same on a starved box as on an idle one, where a findBy* / waitFor budget in ms is not.
 */
const turns = async (n: number) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise<void>(r => setImmediate(r)); });
};
const untilAsked = async (needle: string) => {
  for (let i = 0; i < 500 && !asked().some(u => u.includes(needle)); i += 1) await turns(1);
};

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
    await untilAsked('/api/auth/me');
    expect(asked().some(u => u.includes('/api/auth/me'))).toBe(true);
  }, LOAD_TIMEOUT);

  it('fetches neither the session nor the companies on a share route', async () => {
    pathname = '/share/[token]';
    await mount();
    // App has mounted (its page text is on screen), and both fetches, which live in mount effects, get 50 event-loop
    // turns to be wrong in. The ordinary-page test above shows the session fetch lands within a few turns when asked.
    expect(screen.getByText('shared pack')).toBeTruthy();
    await turns(50);
    expect(asked().some(u => u.includes('/api/auth/me'))).toBe(false);
    expect(asked().some(u => u.includes('/api/accounting/companies'))).toBe(false);
  }, LOAD_TIMEOUT);
});
