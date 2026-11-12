/**
 * App audit P2.7 / P3.4: named nav landmarks, no second banner, the cog's own active state, and a drawer with a
 * visible close button and no "X home" row that repeats a daily link.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { LayoutDashboard } from 'lucide-react';

const router = vi.hoisted(() => ({ pathname: '/accounting', asPath: '/accounting', query: {}, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, logout: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/image', () => ({ default: () => null }));

import { AccountingNav } from '@/components/accounting/AccountingNav';
import { SecondaryModuleNav } from '@/components/accounting/SecondaryModuleNav';
import { DashboardHero } from '@/components/accounting/dashboard/DashboardHero';
import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { DrawerNav } from '@/components/layout/DrawerNav';
import { AppSidebar } from '@/components/layout/AppSidebar';

const at = (path: string) => { router.pathname = path; router.asPath = path; };
afterEach(() => { cleanup(); at('/accounting'); });

describe('nav landmarks', () => {
  it('names the top nav "Main"', () => {
    render(<AccountingNav />);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it('names the second row after its module and hides the visible label from screen readers', () => {
    at('/accounting/customers');
    render(<SecondaryModuleNav moduleId="sales" />);
    const nav = screen.getByRole('navigation', { name: 'Sales sections' });
    expect(nav).toBeTruthy();
    const label = screen.getByText('Sales', { selector: 'span' });
    expect(label.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws no second row on a settings page: the cog carries the state (the row overflowed at 1024 px)', () => {
    at('/accounting/user-access');
    const { container } = render(<SecondaryModuleNav moduleId="settings" />);
    expect(container.innerHTML).toBe('');
  });

  it('the dashboard hero is a named region, not a second banner', () => {
    render(
      <DashboardHero companyName="Demo" activeTab="overview" onTabChange={() => {}}
        tabs={[{ id: 'overview', label: 'Overview', icon: LayoutDashboard }]} />,
    );
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.getByRole('region', { name: 'Dashboard overview' })).toBeTruthy();
  });
});

describe('settings cog', () => {
  it('is current on a settings page and marks that page in its panel', () => {
    at('/accounting/user-access');
    render(<SettingsMenu />);
    const cog = screen.getByRole('button', { name: 'Settings' });
    expect(cog.getAttribute('aria-current')).toBe('true');
    fireEvent.click(cog);
    const current = screen.getAllByRole('menuitem').filter((i) => i.getAttribute('aria-current') === 'page');
    expect(current.map((i) => i.textContent)).toEqual(['User Access']);
  });

  it('is not current on the dashboard', () => {
    render(<SettingsMenu />);
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('mobile drawer', () => {
  it('opens Banking straight on its daily links: no "Banking home" that repeats "Transactions"', () => {
    render(<DrawerNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Banking' }));
    expect(screen.queryByRole('link', { name: 'Banking home' })).toBeNull();
    // One row above the sections opens Transactions; the Transactions section stays closed.
    const toTransactions = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/accounting/bank-transactions');
    expect(toTransactions.map((a) => a.textContent)).toEqual(['Transactions']);
  });

  it('opens Sales on "Invoices" once: no "Sales home" beside the daily link to the same page', () => {
    render(<DrawerNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Sales' }));
    expect(screen.queryByRole('link', { name: 'Sales home' })).toBeNull();
    const toInvoices = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/accounting/customer-invoices');
    expect(toInvoices.map((a) => a.textContent)).toEqual(['Invoices']);
  });

  it('keeps "Library home", whose landing no daily link repeats', () => {
    render(<DrawerNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    expect(screen.getByRole('link', { name: 'Library home' })).toBeTruthy();
  });

  it('has a visible close button that closes it and hands focus back to the hamburger', () => {
    const onCloseMobile = vi.fn();
    const menuButtonRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={menuButtonRef}>Open menu</button>
        <AppSidebar showSidebar={false} collapsed={false} onToggleCollapsed={() => {}} mobileOpen onCloseMobile={onCloseMobile} menuButtonRef={menuButtonRef} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(onCloseMobile).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(menuButtonRef.current);
  });
});
