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
import { cleanup, render, screen, act } from '@testing-library/react';

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
/** Turns until `needle` was asked for; throws when 500 turns pass without it. */
const untilAsked = async (needle: string): Promise<number> => {
  for (let n = 0; n < 500; n += 1) {
    if (asked().some(u => u.includes(needle))) return n;
    await turns(1);
  }
  throw new Error(`${needle} was never asked for in 500 turns`);
};

/** Mount an ordinary app page and return how many turns its slower provider fetch (session or companies) took. */
async function controlTurnsOnOrdinaryPage(): Promise<number> {
  pathname = '/accounting/reports/report-packs';
  fetchMock.mockClear();
  await mount();
  const n = Math.max(await untilAsked('/api/auth/me'), await untilAsked('/api/accounting/companies'));
  cleanup();
  return n;
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
    await untilAsked('/api/auth/me');
    await untilAsked('/api/accounting/companies'); // the mock's `data: {}` counts as a user, so companies follow
    expect(asked().some(u => u.includes('/api/auth/me'))).toBe(true);
    expect(asked().some(u => u.includes('/api/accounting/companies'))).toBe(true);
  }, LOAD_TIMEOUT);

  it('fetches neither the session nor the companies on a share route', async () => {
    // Measure how many turns the slower provider fetch takes on an ordinary page, in this same test (so `-t` runs keep it),
    // then give the share route at least 5x that (and never fewer than 50) to be wrong in.
    const control = await controlTurnsOnOrdinaryPage();
    pathname = '/share/[token]';
    fetchMock.mockClear();
    await mount();
    expect(screen.getByText('shared pack')).toBeTruthy();
    await turns(Math.max(50, control * 5));
    expect(asked().some(u => u.includes('/api/auth/me'))).toBe(false);
    // Companies load only for an authenticated user, so this fails on its own only if the session gate is broken too.
    expect(asked().some(u => u.includes('/api/accounting/companies'))).toBe(false);
  }, LOAD_TIMEOUT);
});
