/**
 * AppLayout after the split into AppHeader / AppSidebar / useGlobalShortcuts / PwaInstallBanner: the wiring between
 * them, rendered for real with the heavy children stubbed. Plus the document-title precedence with the real next/head.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import Head from 'next/head';
import { HeadManagerContext } from 'next/dist/shared/lib/head-manager-context.shared-runtime';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  router: { pathname: '/accounting', asPath: '/accounting', query: {}, push: vi.fn(async () => true) },
  auth: { loading: false, user: { firstName: 'Q', lastName: 'A', email: 'qa@x' } as unknown, logout: vi.fn(async () => undefined), authUnavailable: false, authChecking: false, refreshUser: vi.fn() },
}));
vi.mock('next/router', () => ({ useRouter: () => h.router }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'c1', vatPeriod: 'bi-monthly', vatSystemType: 'invoice' }, companyRole: 'owner', loading: false, companies: [] }),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/hooks/useTrackPageVisit', () => ({ useTrackPageVisit: () => undefined }));
vi.mock('@/lib/auth/sessionHeartbeat', () => ({ startSessionHeartbeat: () => () => undefined }));
vi.mock('@/components/accounting/AccountingNav', () => ({ AccountingNav: () => null }));
vi.mock('@/components/accounting/SecondaryModuleNav', () => ({ SecondaryModuleNav: () => null }));
vi.mock('@/components/layout/SidebarNav', () => ({ SidebarNav: () => null }));
vi.mock('@/components/layout/DrawerNav', () => ({ DrawerNav: () => <nav><a href="/accounting/customer-invoices">Invoices</a></nav> }));
vi.mock('@/components/layout/CommandPalette', () => ({ CommandPalette: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="palette" /> : null) }));
vi.mock('@/components/layout/ShortcutHelpOverlay', () => ({ ShortcutHelpOverlay: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="shortcut-help" /> : null) }));
vi.mock('@/components/onboarding/AccountingTour', () => ({ AccountingTour: () => null }));
vi.mock('@/components/onboarding/SetupGuideButton', () => ({ SetupGuideButton: () => null }));
vi.mock('@/components/layout/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/payroll/PayrollPeriodBar', () => ({ PayrollPeriodBar: () => <div data-testid="payroll-period-bar" /> }));
vi.mock('@/components/layout/CompanySwitcher', () => ({ CompanySwitcher: () => null }));
vi.mock('@/components/layout/CreateNewMenu', () => ({ CreateNewMenu: () => null }));
vi.mock('@/components/layout/SettingsMenu', () => ({ SettingsMenu: () => null }));
vi.mock('@/components/layout/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/ui/TableDensityToggle', () => ({ TableDensityToggle: () => null }));

import { AppLayout } from '@/components/layout/AppLayout';
import { ShellTitle } from '@/components/layout/ShellTitle';

const go = (pathname: string) => { h.router.pathname = pathname; h.router.asPath = pathname; };
const page = (body: ReactNode = <p>page</p>) => <AppLayout>{body}</AppLayout>;
const hamburger = () => screen.getByRole('button', { name: 'Open menu' });

beforeEach(() => { go('/accounting'); h.auth.loading = false; h.router.push.mockClear(); h.auth.logout.mockClear(); localStorage.clear(); });
afterEach(cleanup);

describe('AppLayout', () => {
  it('mounts PayrollPeriodBar on /payroll pages only, by segment', () => {
    go('/payroll/runs');
    const { unmount } = render(page());
    expect(screen.getByTestId('payroll-period-bar')).toBeTruthy();
    unmount();
    go('/payrollx');
    render(page());
    expect(screen.queryByTestId('payroll-period-bar')).toBeNull();
  });

  it('Ctrl+K opens the command palette, "?" the shortcut help, G then D goes to the dashboard', () => {
    render(page());
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('palette')).toBeTruthy();
    fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByTestId('shortcut-help')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'd' });
    expect(h.router.push).toHaveBeenCalledWith('/accounting');
  });

  it('the hamburger opens and closes the drawer; a closed drawer is out of the tab order', () => {
    render(page());
    const drawer = screen.getByTestId('mobile-drawer');
    expect(drawer.className).toContain('invisible');
    fireEvent.click(hamburger());
    expect(hamburger().getAttribute('aria-expanded')).toBe('true');
    expect(drawer.className).not.toContain('invisible');
    fireEvent.click(hamburger());
    expect(hamburger().getAttribute('aria-expanded')).toBe('false');
    expect(drawer.className).toContain('invisible');
  });

  it('Escape closes the open drawer and returns focus to the hamburger; opening moves focus into it', () => {
    render(page());
    fireEvent.click(hamburger());
    expect(document.activeElement?.textContent).toBe('Invoices');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hamburger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(hamburger());
  });

  it('a route change closes the drawer', () => {
    const { rerender } = render(page());
    fireEvent.click(hamburger());
    go('/accounting/customer-invoices');
    rerender(page());
    expect(hamburger().getAttribute('aria-expanded')).toBe('false');
  });

  it('Log out calls logout', () => {
    render(page());
    fireEvent.click(screen.getByTitle('Log out'));
    expect(h.auth.logout).toHaveBeenCalledTimes(1);
  });

  it('keeps an install prompt that fires during the session check', () => {
    h.auth.loading = true;
    const { rerender } = render(page());
    act(() => { window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true })); });
    h.auth.loading = false;
    rerender(page());
    expect(screen.getByText('Install IsaFlow for a faster, app-like experience')).toBeTruthy();
  });
});

describe('document title precedence (real next/head)', () => {
  let title = '';
  const headManager = {
    mountedInstances: new Set<unknown>(),
    updateHead: (state: Array<{ type: string; props: { children?: unknown } }>) => {
      const t = state.find((e) => e.type === 'title');
      title = t ? String(([] as unknown[]).concat(t.props.children ?? '').join('')) : '';
    },
  };
  // _app's order: ShellTitle, then the page.
  const app = (pageTree: ReactNode) => (
    <HeadManagerContext.Provider value={headManager as never}><ShellTitle />{pageTree}</HeadManagerContext.Provider>
  );
  const own = <Head><title>Own Title</title></Head>;

  beforeEach(() => { title = ''; headManager.mountedInstances.clear(); go('/accounting/customer-invoices'); });

  it('without a page title, names the page and its module', () => {
    render(app(page()));
    expect(title).toBe('Tax Invoices · Sales · IsaFlow');
  });

  it.each([
    ['inside AppLayout', () => page(own)],
    ['before AppLayout', () => <>{own}{page()}</>],
  ])('a page title %s wins, through the session check and a layout re-render', (_where, tree) => {
    h.auth.loading = true;
    const { rerender } = render(app(tree()));
    h.auth.loading = false;
    rerender(app(tree()));
    expect(title).toBe('Own Title');
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true }); // re-renders AppLayout
    expect(title).toBe('Own Title');
  });
});
