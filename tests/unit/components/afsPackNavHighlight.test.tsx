/**
 * A management pack lives at the same URL as an AFS document (/accounting/afs/<id>), so the page hands AppLayout a
 * navPath with ?type=management_pack (afsDocumentNavPath.test.tsx). Reports has no section bar, so the main-row menu
 * (top mode) and the sidebar flyout (side mode) are what must mark "Pack Documents" from it: the router's own path
 * names no pack.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting/afs/[documentId]', asPath: '/accounting/afs/p1', query: { documentId: 'p1' }, push: vi.fn() }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ loading: false, user: { id: 'u1', firstName: 'Q', lastName: 'A', email: 'qa@x' }, logout: vi.fn(), authUnavailable: false, authChecking: false, refreshUser: vi.fn() }),
}));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'c1', vatPeriod: 'bi-monthly', vatSystemType: 'invoice' }, companyRole: 'owner', loading: false, companies: [] }),
}));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => new Set<string>() }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/hooks/useTrackPageVisit', () => ({ useTrackPageVisit: () => undefined }));
vi.mock('@/lib/auth/sessionHeartbeat', () => ({ startSessionHeartbeat: () => () => undefined }));
vi.mock('@/components/layout/DrawerNav', () => ({ DrawerNav: () => null }));
vi.mock('@/components/layout/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/layout/ShortcutHelpOverlay', () => ({ ShortcutHelpOverlay: () => null }));
vi.mock('@/components/onboarding/AccountingTour', () => ({ AccountingTour: () => null }));
vi.mock('@/components/onboarding/SetupGuideButton', () => ({ SetupGuideButton: () => null }));
vi.mock('@/components/layout/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/layout/AnnouncementBanner', () => ({ AnnouncementBanner: () => null }));
vi.mock('@/components/layout/CompanySwitcher', () => ({ CompanySwitcher: () => null }));
vi.mock('@/components/layout/CreateNewMenu', () => ({ CreateNewMenu: () => null }));
vi.mock('@/components/layout/SettingsMenu', () => ({ SettingsMenu: () => null }));
vi.mock('@/components/layout/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/ui/TableDensityToggle', () => ({ TableDensityToggle: () => null }));

import { AppLayout } from '@/components/layout/AppLayout';

const PACK = '/accounting/afs/p1?type=management_pack';

afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-nav-mode'); });

describe('AFS management pack: the nav marks Pack Documents from the page\'s navPath', () => {
  it('top mode: the Reports main-row menu marks Pack Documents under Management Packs', () => {
    render(<AppLayout navPath={PACK}><p>pack</p></AppLayout>);
    const reports = document.querySelector<HTMLElement>('[data-tour="nav-reports"]')!;
    fireEvent.click(within(reports).getByRole('button', { name: 'Reports menu' }));
    fireEvent.click(within(reports).getByRole('button', { name: 'Management Packs' }));
    const panel = document.getElementById(within(reports).getByRole('button', { name: 'Management Packs' }).getAttribute('aria-controls')!)!;
    const lit = within(panel).getAllByRole('link').filter((a) => !a.className.includes('text-ink-muted')).map((a) => a.textContent);
    expect(lit).toEqual(['Pack Documents']);
  });

  it('side mode: the Reports sidebar flyout marks Pack Documents under Management Packs', () => {
    document.documentElement.setAttribute('data-nav-mode', 'side');
    render(<AppLayout navPath={PACK}><p>pack</p></AppLayout>);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-reports'));
    const row = [...document.querySelectorAll<HTMLElement>('[data-flyout-row]')].find((el) => el.textContent === 'Management Packs')!;
    fireEvent.click(row);
    const panel = [...document.querySelectorAll<HTMLElement>('[data-sidebar-flyout]')].find((el) => within(el).queryByRole('link', { name: 'Pack Documents' }))!;
    const lit = within(panel).getAllByRole('link').filter((a) => a.className.includes('font-medium')).map((a) => a.textContent);
    expect(lit).toEqual(['Pack Documents']);
  });
});
