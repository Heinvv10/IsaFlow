/**
 * The print dispatcher in pages/accounting/reports/report-packs.tsx must pick
 * PackPrintPage on the VERY FIRST client render of `?print=1`.
 *
 * Mounting the interactive screen even once during a print render is not a
 * cosmetic flash: `_app.tsx` branches on the same signal, so the same
 * mistaken pass mounts AuthProvider ungated, its effect fires
 * `/api/auth/me`, and that handler clears the `sb-access-token` cookie
 * carrying the print token — killing every later request in the render.
 *
 * What makes the first render safe is `getServerSideProps` (pinned below):
 * with it, `router.isReady` is true and `router.query` is populated from the
 * very first client pass. `isPrintRender` therefore reads the router and
 * nothing else — the `window.location` fallback that used to cover a
 * not-ready window is gone, because that window cannot occur on this page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
// The page mounts WS3's owner-side tools, which read the company role from
// context. These suites render the page outside any provider, and this is not
// what any of them is about: a viewer's role draws no Share button and no
// commentary panel, so the surfaces under test are unchanged either way.
// `tests/unit/components/reports/reportPacksShareMount.test.tsx` is where the
// role gate itself is held.
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer' }) }));

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

beforeEach(() => {
  useRouterMock.mockReset();
});

describe('ReportPacksPage print dispatch', () => {
  it('mounts the print page for ?print=1, carrying the requested pack through', () => {
    useRouterMock.mockReturnValue({
      isReady: true, pathname: PRINT_RENDER_PATH,
      query: { pack: 'management', from: '2026-01-01', to: '2026-08-31', print: '1' },
    });

    render(<ReportPacksPage />);

    expect(screen.getByTestId('print-page')).toHaveTextContent('management');
    expect(screen.queryByTestId('interactive-screen')).toBeNull();
  });

  it('mounts the interactive screen for a normal, non-print visit', () => {
    useRouterMock.mockReturnValue({ isReady: true, pathname: PRINT_RENDER_PATH, query: {} });

    render(<ReportPacksPage />);

    expect(screen.getByTestId('interactive-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('print-page')).toBeNull();
  });

  /**
   * ADVERSARIAL LOW-2: `router.query.pack` is attacker-controllable text and
   * was cast straight to PackType, so an unknown value reached
   * `packTrendApiPath` and was fetched as `/api/accounting/packs/<x>/trend`.
   * Like the data-error state, the refusal never becomes print-ready: the
   * renderer times out loudly rather than photographing the wrong document.
   *
   * ABSENT is not WRONG. `?print=1` with no `pack` predates the parameter and
   * has always meant the management pack, so an old bookmark still prints;
   * only a pack that is present and unrecognised is refused. An empty
   * `?pack=` is present and unrecognised — it names nothing, and no bookmark
   * carries it.
   */
  it.each([['segments'], [''], ['MANAGEMENT'], ['../admin']])(
    'refuses to print an unknown pack type %j rather than casting it through',
    (pack) => {
      useRouterMock.mockReturnValue({
        isReady: true, pathname: PRINT_RENDER_PATH, query: { pack, print: '1' },
      });

      render(<ReportPacksPage />);

      expect(screen.queryByTestId('print-page')).toBeNull();
      expect(screen.getByText(/Unknown pack type/)).toBeInTheDocument();
    },
  );

  it('refuses a repeated ?pack= parameter, which arrives as an array', () => {
    useRouterMock.mockReturnValue({
      isReady: true, pathname: PRINT_RENDER_PATH, query: { pack: ['board', 'management'], print: '1' },
    });

    render(<ReportPacksPage />);

    expect(screen.queryByTestId('print-page')).toBeNull();
    expect(screen.getByText(/Unknown pack type/)).toBeInTheDocument();
  });

  it('defaults to the management pack when no pack is named, so old bookmarks still print', () => {
    useRouterMock.mockReturnValue({ isReady: true, pathname: PRINT_RENDER_PATH, query: { print: '1' } });

    render(<ReportPacksPage />);

    expect(screen.getByTestId('print-page')).toHaveTextContent('management');
    expect(screen.queryByText(/Unknown pack type/)).toBeNull();
  });

  it.each([['board'], ['management'], ['monthly']])('prints the %s pack', (pack) => {
    useRouterMock.mockReturnValue({
      isReady: true, pathname: PRINT_RENDER_PATH, query: { pack, print: '1' },
    });
    render(<ReportPacksPage />);
    expect(screen.getByTestId('print-page')).toHaveTextContent(pack);
  });

  /**
   * The URL is no longer a second source of truth. A not-ready router means
   * "the query is not the authority yet" and nothing else is consulted — on
   * this page it cannot happen, because getServerSideProps is exported.
   */
  it('does not read window.location when the router is not ready', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, pathname: PRINT_RENDER_PATH, search: '?pack=management&print=1' },
    });
    useRouterMock.mockReturnValue({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} });

    render(<ReportPacksPage />);

    expect(screen.queryByTestId('print-page')).toBeNull();
    expect(screen.getByTestId('interactive-screen')).toBeInTheDocument();
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
