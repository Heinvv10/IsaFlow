/**
 * Admin audit 2026-11-14, item 4.3: on the admin host the shell's hamburger drawer and Ctrl+K belonged to the
 * accounting app (Sales, Purchases, a tenant's ledger search) and led to /accounting/* pages that 404 there.
 * AppLayout is rendered for real; the accounting drawer and palette are stubs, so the test sees which one it picked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  router: { pathname: '/admin', asPath: '/admin', query: {}, push: vi.fn(async () => true) },
  apiFetch: vi.fn(),
}));
vi.mock('next/router', () => ({ useRouter: () => h.router }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ loading: false, user: { id: 'u-adm', firstName: 'A', lastName: 'D', email: 'a@x', role: 'super_admin' }, logout: vi.fn() }),
}));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: null, companyRole: null, loading: false, companies: [] }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ toggleTheme: vi.fn() }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: (...a: unknown[]) => h.apiFetch(...a) }));
vi.mock('@/hooks/useTrackPageVisit', () => ({ useTrackPageVisit: () => undefined }));
vi.mock('@/lib/auth/sessionHeartbeat', () => ({ startSessionHeartbeat: () => () => undefined }));
vi.mock('@/components/accounting/AccountingNav', () => ({ AccountingNav: () => null }));
vi.mock('@/components/accounting/SecondaryModuleNav', () => ({ SecondaryModuleNav: () => null }));
vi.mock('@/components/layout/SidebarNav', () => ({ SidebarNav: () => <nav data-testid="accounting-sidebar" /> }));
vi.mock('@/components/layout/DrawerNav', () => ({ DrawerNav: () => <nav aria-label="Main"><a href="/accounting/customers">Sales</a></nav> }));
vi.mock('@/components/layout/CommandPalette', () => ({ CommandPalette: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="tenant-palette" /> : null) }));
vi.mock('@/components/layout/ShortcutHelpOverlay', () => ({ ShortcutHelpOverlay: () => null }));
vi.mock('@/components/onboarding/AccountingTour', () => ({ AccountingTour: () => null }));
vi.mock('@/components/onboarding/SetupGuideButton', () => ({ SetupGuideButton: () => null }));
vi.mock('@/components/layout/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/payroll/PayrollPeriodBar', () => ({ PayrollPeriodBar: () => null }));
vi.mock('@/components/layout/CompanySwitcher', () => ({ CompanySwitcher: () => null }));
vi.mock('@/components/layout/CreateNewMenu', () => ({ CreateNewMenu: () => null }));
vi.mock('@/components/layout/SettingsMenu', () => ({ SettingsMenu: () => null }));
vi.mock('@/components/layout/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/ui/TableDensityToggle', () => ({ TableDensityToggle: () => null }));

import { AppLayout } from '@/components/layout/AppLayout';

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const setAdminHost = (on: boolean) => {
  if (on) document.documentElement.setAttribute('data-admin-host', 'true');
  else document.documentElement.removeAttribute('data-admin-host');
};
/** The saved "sidebar navigation" preference, as shell-init.js puts it on <html>. */
const setSideMode = (on: boolean) => {
  if (on) document.documentElement.setAttribute('data-nav-mode', 'side');
  else document.documentElement.removeAttribute('data-nav-mode');
};
const NAV_TOGGLE = /switch to (sidebar|top) navigation|use (sidebar|top) navigation/i;

beforeEach(() => {
  h.router.push.mockClear();
  h.apiFetch.mockReset().mockResolvedValue(ok({ items: [], total: 0, page: 1, limit: 5 }));
  localStorage.clear();
});
afterEach(() => { cleanup(); setAdminHost(false); setSideMode(false); vi.useRealTimers(); });

describe('AppLayout on the admin host', () => {
  it('the hamburger drawer carries the admin menu, not the accounting one', () => {
    setAdminHost(true);
    render(<AppLayout><p>page</p></AppLayout>);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = screen.getByTestId('mobile-drawer');
    expect(within(drawer).queryByRole('link', { name: 'Sales' })).toBeNull();
    expect(within(drawer).getByRole('link', { name: 'Companies' }).getAttribute('href')).toBe('/admin/companies');
    expect(within(drawer).getByRole('link', { name: 'Plans' }).getAttribute('href')).toBe('/admin/billing/plans');
    expect(within(drawer).getByRole('link', { name: 'Email Log' }).getAttribute('href')).toBe('/admin/email-log');
  });

  it('Ctrl+K opens the admin palette: "plans" finds the Plans page, and nothing searches a tenant ledger', async () => {
    setAdminHost(true);
    render(<AppLayout><p>page</p></AppLayout>);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('tenant-palette')).toBeNull();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'plans' } });
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('Plans');
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledTimes(2));
    expect(h.apiFetch.mock.calls.map(([url]) => String(url).split('?')[0]).sort()).toEqual(['/api/admin/companies', '/api/admin/users']);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(h.router.push).toHaveBeenCalledWith('/admin/billing/plans');
  });
});

describe('AppLayout on the admin host: no accounting sidebar, no accounting shortcuts', () => {
  it('a saved sidebar preference does not draw the accounting sidebar, and no control switches to it', () => {
    setAdminHost(true);
    setSideMode(true);
    render(<AppLayout><p>page</p></AppLayout>);
    expect(screen.queryByTestId('accounting-sidebar')).toBeNull();
    expect(screen.queryByRole('button', { name: NAV_TOGGLE })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Account and display settings' }));
    expect(screen.queryByRole('button', { name: NAV_TOGGLE })).toBeNull();
  });

  it('"G then D" and the other accounting go-to keys do nothing', () => {
    setAdminHost(true);
    render(<AppLayout><p>page</p></AppLayout>);
    for (const k of ['d', 's', 'b', 'y']) {
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: k });
    }
    expect(h.router.push).not.toHaveBeenCalled();
  });
});

describe('AppLayout on the app host', () => {
  it('keeps the sidebar preference, its toggle and the go-to keys', () => {
    setAdminHost(false);
    setSideMode(true);
    render(<AppLayout><p>page</p></AppLayout>);
    expect(screen.getByTestId('accounting-sidebar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Switch to top navigation' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'd' });
    expect(h.router.push).toHaveBeenCalledWith('/accounting');
  });

  it('keeps the accounting drawer and palette', () => {
    setAdminHost(false);
    render(<AppLayout><p>page</p></AppLayout>);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(within(screen.getByTestId('mobile-drawer')).getByRole('link', { name: 'Sales' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('tenant-palette')).toBeTruthy();
  });
});
