/**
 * The public share page must not install a service worker.
 *
 * `public/sw.js` caches any 200 text/html GET and serves it offline, ignoring
 * `no-store`. A recipient who opened one shared pack would be left with the
 * pack — and the token inside `__NEXT_DATA__` — on their disk, still served
 * after the sender revoked the link. sw.js now refuses to cache `/share/`
 * (see serviceWorkerShareCache.test.ts); this suite covers the other half:
 * a recipient's browser never acquires a worker for this origin at all.
 *
 * A render with the effect actually run, not a grep: the gate is a branch
 * inside useEffect and only a mounted component exercises it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor } from '@testing-library/react';

const register = vi.fn(() => Promise.resolve());
const getRegistrations = vi.fn(() => Promise.resolve([]));

let pathname = '/accounting/reports/report-packs';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname, events: { on: () => {}, off: () => {} } }),
}));
vi.mock('@/components/analytics/TrackerScript', () => ({ TrackerScript: () => null }));

describe('pages/_app.tsx — service worker registration', () => {
  beforeEach(() => {
    register.mockClear();
    getRegistrations.mockClear();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, getRegistrations },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'serviceWorker');
  });

  async function mount() {
    const { default: App } = await import('../../../pages/_app');
    render(
      React.createElement(App, {
        Component: () => React.createElement('main', null, 'page'),
        pageProps: {},
        router: {} as never,
      } as never),
    );
  }

  it('touches the service worker API on an ordinary app page', async () => {
    pathname = '/accounting/reports/report-packs';
    await mount();
    // Under NODE_ENV=test the effect takes its non-production branch, which
    // tears down a worker a previous prod build left. Either call proves the
    // gate let the page through; which one depends only on the environment.
    await waitFor(() => {
      expect(register.mock.calls.length + getRegistrations.mock.calls.length).toBeGreaterThan(0);
    });
  });

  it('does not touch it at all on the public share page', async () => {
    pathname = '/share/[token]';
    await mount();
    // Given a tick to be wrong in.
    await new Promise(r => setTimeout(r, 0));
    expect(register).not.toHaveBeenCalled();
    expect(getRegistrations).not.toHaveBeenCalled();
  });
});
