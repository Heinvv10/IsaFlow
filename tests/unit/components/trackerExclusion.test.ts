/**
 * The public share page must not be tracked.
 *
 * `public/isa-track.js` sends `location.pathname`, and on a share link the
 * pathname IS the credential — live tokens were confirmed sitting in
 * `analytics_events.url_path`, readable by anyone with analytics access, for
 * as long as that table is retained. The recipient is also a third party who
 * never agreed to be measured.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isTrackedPath } from '@/modules/analytics/isTrackedPath';

describe('isTrackedPath', () => {
  it('excludes the public share page and everything under it', () => {
    expect(isTrackedPath('/share')).toBe(false);
    expect(isTrackedPath('/share/abc123')).toBe(false);
    expect(isTrackedPath('/share/abc123/')).toBe(false);
    // Next hands the App the ROUTE, not the resolved URL, on a dynamic page.
    expect(isTrackedPath('/share/[token]')).toBe(false);
  });

  it('keeps every app page tracked', () => {
    expect(isTrackedPath('/')).toBe(true);
    expect(isTrackedPath('/accounting/reports/report-packs')).toBe(true);
    expect(isTrackedPath('/shared-with-me')).toBe(true);
    expect(isTrackedPath('/sharepoint')).toBe(true);
  });
});

describe('pages/_app.tsx — the gate, rendered', () => {
  it('mounts the tracker on an app page and omits it on the share page', async () => {
    // A render, not a grep over the source: a regex passes on a comment
    // containing the same string and proves nothing about what ships.
    // TrackerScript is stubbed to a marker because next/script renders nothing
    // outside a Next runtime, which would make the assertion vacuous.
    vi.doMock('@/components/analytics/TrackerScript', () => ({
      TrackerScript: () => React.createElement('div', { 'data-testid': 'tracker' }),
    }));
    let pathname = '/accounting/reports/report-packs';
    vi.doMock('next/router', () => ({
      useRouter: () => ({ pathname, events: { on: () => {}, off: () => {} } }),
    }));

    const { default: App } = await import('../../../pages/_app');
    const render = () => renderToStaticMarkup(
      React.createElement(App, {
        Component: () => React.createElement('main', null, 'page'),
        pageProps: {},
        router: {} as never,
      } as never),
    );

    expect(render()).toContain('data-testid="tracker"');

    pathname = '/share/[token]';
    expect(render()).not.toContain('data-testid="tracker"');
  });
});
