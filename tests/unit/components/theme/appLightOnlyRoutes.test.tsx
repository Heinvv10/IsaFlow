/**
 * pages/_app.tsx decides the theme per ROUTE: the customer portal (invoice, pay) and the other public
 * surfaces render light even when Dark is saved, and the app routes still follow the saved choice.
 * Mounts the real App and ThemeProvider; router.pathname is the route template, as in Next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

let pathname = '/accounting';
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname, asPath: pathname, query: {}, isReady: true, events: { on: () => {}, off: () => {} }, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/analytics/TrackerScript', () => ({ TrackerScript: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/contexts/CompanyContext', () => ({
  CompanyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCompany: () => ({ activeCompany: null, loading: true }), // _app's ShellTitle reads it
}));

const LOAD_TIMEOUT = 60_000;

beforeEach(() => {
  window.localStorage.setItem('accounting-theme', 'dark');
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.themeApplied;
});
afterEach(cleanup);

async function mountAt(route: string): Promise<void> {
  pathname = route;
  const { default: App } = await import('../../../../pages/_app');
  render(React.createElement(App, { Component: () => <main>page</main>, pageProps: {}, router: {} as never } as never));
  expect(await screen.findByText('page')).toBeTruthy();
}

describe('_app lightOnly wiring', () => {
  it.each(['/portal/invoice/[token]', '/portal/pay/[token]', '/portal', '/share/[token]', '/audit-portal/[sessionId]'])(
    '%s renders light with Dark saved',
    async (route) => {
      await mountAt(route);
      await waitFor(() => expect(document.documentElement.dataset.themeApplied).toBe('light'));
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
      expect(window.localStorage.getItem('accounting-theme')).toBe('dark');
    },
    LOAD_TIMEOUT,
  );

  it('an app route follows the saved Dark', async () => {
    await mountAt('/accounting/customer-invoices');
    await waitFor(() => expect(document.documentElement.dataset.themeApplied).toBe('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  }, LOAD_TIMEOUT);
});
