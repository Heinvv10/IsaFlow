/**
 * The print dispatcher in pages/accounting/reports/report-packs.tsx must pick
 * PackPrintPage on the VERY FIRST client render of `?print=1`, while
 * `router.isReady` is still false and `router.query` is still `{}`.
 *
 * Mounting the interactive screen even once during a print render is not a
 * cosmetic flash: `_app.tsx` branches on the same signal, so the same
 * mistaken pass mounts AuthProvider ungated, its effect fires
 * `/api/auth/me`, and that handler clears the `sb-access-token` cookie
 * carrying the print token — killing every later request in the render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const useRouterMock = vi.fn();
vi.mock('next/router', () => ({
  useRouter: () => useRouterMock(),
}));

vi.mock('@/components/accounting/packs/PackPrintPage', () => ({
  PackPrintPage: ({ packType }: { packType: string }) => (
    <div data-testid="print-page">{packType}</div>
  ),
}));

// The interactive screen is the only consumer of AppLayout on this page, so a
// sentinel here is an unambiguous "the wrong branch mounted" signal.
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="interactive-screen">{children}</div>
  ),
}));

vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}'))),
  assertOk: vi.fn(() => Promise.resolve({})),
}));

import ReportPacksPage, { getServerSideProps } from '../../../../pages/accounting/reports/report-packs';
import { PRINT_RENDER_PATH } from '@/lib/pdf/printRenderQuery';

const originalSearch = window.location.search;

/** The gate is scoped to the pack page's own path as well as ?print=1
 *  (printRenderQuery.ts), so the stubbed location has to carry both. */
function setSearch(search: string, pathname: string = PRINT_RENDER_PATH) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname, search },
  });
}

beforeEach(() => {
  useRouterMock.mockReset();
});

afterEach(() => {
  setSearch(originalSearch);
});

describe('ReportPacksPage print dispatch', () => {
  it('mounts the print page, not the interactive screen, on the first render when the router is not ready', () => {
    setSearch('?pack=management&from=2026-01-01&to=2026-08-31&print=1');
    useRouterMock.mockReturnValue({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} });

    render(<ReportPacksPage />);

    expect(screen.getByTestId('print-page')).toHaveTextContent('management');
    expect(screen.queryByTestId('interactive-screen')).toBeNull();
  });

  it('still mounts the print page once the router becomes ready', () => {
    setSearch('?pack=management&print=1');
    useRouterMock.mockReturnValue({ isReady: true, pathname: PRINT_RENDER_PATH, query: { pack: 'management', print: '1' } });

    render(<ReportPacksPage />);

    expect(screen.getByTestId('print-page')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-screen')).toBeNull();
  });

  it('mounts the interactive screen for a normal, non-print visit', () => {
    setSearch('');
    useRouterMock.mockReturnValue({ isReady: true, pathname: PRINT_RENDER_PATH, query: {} });

    render(<ReportPacksPage />);

    expect(screen.getByTestId('interactive-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('print-page')).toBeNull();
  });
});

describe('ReportPacksPage server rendering', () => {
  /**
   * The page must be server-rendered, not statically optimised. Static
   * optimisation is what leaves `router.query` empty on the server pass: the
   * server then picks the interactive screen while the client's first pass
   * picks the print page, React fails hydration, and the dev overlay is drawn
   * across every page of the rendered PDF.
   */
  it('exports getServerSideProps so router.query is populated on the server pass', async () => {
    expect(getServerSideProps).toBeTypeOf('function');
    await expect(getServerSideProps()).resolves.toEqual({ props: {} });
  });
});
