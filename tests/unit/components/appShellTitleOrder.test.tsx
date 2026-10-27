/**
 * The real pages/_app.tsx renders ShellTitle BEFORE the page, so a page's own <title> always wins (next/head keeps the
 * last-mounted title). Rendered with the real next/head reducer behind a recording head manager: moving ShellTitle
 * after <Component> in _app turns this red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import Head from 'next/head';
import { cleanup, render, screen } from '@testing-library/react';
import { HeadManagerContext } from 'next/dist/shared/lib/head-manager-context.shared-runtime';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting/customer-invoices', asPath: '/accounting/customer-invoices', query: {}, isReady: true, events: { on: () => {}, off: () => {} }, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/analytics/TrackerScript', () => ({ TrackerScript: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/contexts/CompanyContext', () => ({
  CompanyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCompany: () => ({ activeCompany: null, loading: true }),
}));

afterEach(cleanup);

let title = '';
const headManager = {
  mountedInstances: new Set<unknown>(),
  updateHead: (state: Array<{ type: string; props: { children?: unknown } }>) => {
    const t = state.find((e) => e.type === 'title');
    title = t ? ([] as unknown[]).concat(t.props.children ?? '').join('') : '';
  },
};

async function renderApp(Page: () => React.ReactElement) {
  title = '';
  headManager.mountedInstances.clear();
  const { default: App } = await import('../../../pages/_app');
  render(
    <HeadManagerContext.Provider value={headManager as never}>
      {React.createElement(App, { Component: Page, pageProps: {}, router: {} as never } as never)}
    </HeadManagerContext.Provider>,
  );
  expect(await screen.findByText('page')).toBeTruthy();
}

describe('_app document title order', () => {
  it('names the page from the nav when the page has no title of its own', async () => {
    await renderApp(() => <main>page</main>);
    expect(title).toBe('Tax Invoices · Sales · IsaFlow');
  });

  it("a page's own <title> wins over the shell's", async () => {
    await renderApp(() => <><Head><title>Own Title</title></Head><main>page</main></>);
    expect(title).toBe('Own Title');
  });
});
