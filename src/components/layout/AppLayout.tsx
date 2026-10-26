/**
 * Standalone AppLayout for the Accounting app.
 * Supports two nav modes: top-bar (Sage-style, default) or sidebar.
 * User preference persisted in localStorage.
 *
 * Pieces: AppHeader (header bar), AppSidebar (desktop sidebar + mobile drawer), useGlobalShortcuts, PwaInstallBanner,
 * and ShellSkeleton while the first session check runs. The nav slots are pinned to SHELL_HEIGHTS so the content
 * does not jump when the shell arrives (CLS). Below `lg` the top nav rows give way to the hamburger drawer.
 */

import { useState, useEffect, useMemo, useCallback, memo, ReactNode } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useTrackPageVisit } from '@/hooks/useTrackPageVisit';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { startSessionHeartbeat } from '@/lib/auth/sessionHeartbeat';
import { AccountingNav } from '@/components/accounting/AccountingNav';
import { SecondaryModuleNav } from '@/components/accounting/SecondaryModuleNav';
import { getActiveModuleId, TABS } from '@/components/accounting/accountingNavConfig';
import { MODULE_BY_ID } from '@/components/accounting/navSections/secondaryNav';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { ShortcutHelpOverlay } from '@/components/layout/ShortcutHelpOverlay';
import { AccountingTour } from '@/components/onboarding/AccountingTour';
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner';
import { PayrollPeriodBar } from '@/components/payroll/PayrollPeriodBar';
import { AppHeader } from '@/components/layout/AppHeader';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { ShellSkeleton } from '@/components/layout/ShellSkeleton';
import { PwaInstallBanner } from '@/components/layout/PwaInstallBanner';
import { useGlobalShortcuts } from '@/components/layout/useGlobalShortcuts';
import { SHELL_HEIGHTS } from '@/components/layout/shellHeights';
import { documentTitle, isPayrollPath } from '@/components/layout/shellRoutes';

const SIDEBAR_COLLAPSED_KEY = 'accounting-sidebar-collapsed';
const NAV_MODE_KEY = 'accounting-nav-mode';

type NavMode = 'top' | 'side';

/**
 * The shell's fallback <title>. Memoised on the string: next/head moves a Head to the end of its list (where the
 * last title wins) every time it re-renders, so re-rendering this one with the layout would let it beat a page's own
 * <title>. It re-renders only when the title itself changes.
 */
const ShellTitle = memo(function ShellTitle({ title }: { title: string }) {
  return <Head><title>{title}</title></Head>;
});

// ─── Props ──────────────────────────────────────────────────────────────────

interface AppLayoutProps {
  children: ReactNode;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AppLayout({ children }: AppLayoutProps) {
  const router = useRouter();
  const activeModuleId = getActiveModuleId(
    router.pathname,
    router.query as Record<string, string | string[] | undefined>,
  );
  const hasModuleNav = !!MODULE_BY_ID[activeModuleId];
  const { user, loading } = useAuth();
  const { activeCompany } = useCompany();
  const { isRegistered } = useVatRegistration();
  const navIndex = useMemo(() => buildNavIndex(TABS, isRegistered), [isRegistered]);
  const title = documentTitle(router.asPath, navIndex);

  // Track page visits for usage-based quick actions
  useTrackPageVisit();

  // PRD-10 Layer 1: keep the session refreshed and bounce on idle.
  // Restarts when the active company changes so a tighter idle policy on a
  // different tenant takes effect immediately.
  useEffect(() => {
    if (!user) return;
    const idle = activeCompany?.idleTimeoutMinutes ?? 480;
    return startSessionHeartbeat({ idleTimeoutMinutes: idle });
  }, [user, activeCompany?.id, activeCompany?.idleTimeoutMinutes]);

  // On admin subdomain, hide accounting-specific UI (nav, company switcher, etc.)
  const [isAdminHost, setIsAdminHost] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hostname === 'admin.isaflow.co.za') {
      setIsAdminHost(true);
    }
  }, []);

  // Command palette
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Shortcut help overlay
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);

  // Nav mode preference
  const [navMode, setNavMode] = useState<NavMode>('top');

  // Mobile sidebar open state (used in both modes for mobile)
  const [mobileOpen, setMobileOpen] = useState(false);

  // Desktop collapsed state (sidebar mode only)
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const savedMode = localStorage.getItem(NAV_MODE_KEY) as NavMode | null;
    if (savedMode === 'top' || savedMode === 'side') setNavMode(savedMode);
    const savedCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (savedCollapsed !== null) setCollapsed(JSON.parse(savedCollapsed) as boolean);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) {
      localStorage.setItem(NAV_MODE_KEY, navMode);
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
    }
  }, [collapsed, navMode, hydrated]);

  // ─── Global keyboard shortcuts ────────────────────────────────────────────
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const openShortcutHelp = useCallback(() => setShortcutHelpOpen(true), []);
  const globalShortcuts = useGlobalShortcuts({ openCommandPalette, openShortcutHelp });

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [router.pathname]);

  const toggleNavMode = () => setNavMode(m => m === 'top' ? 'side' : 'top');

  const showSidebar = navMode === 'side';
  const showTopNav = !showSidebar && !isAdminHost;

  if (loading) {
    // D9: during an auth-service outage the skeleton's content area explains itself and offers Retry.
    return (
      <>
        <ShellTitle title={title} />
        <ShellSkeleton navMode={navMode} collapsed={collapsed} showTopNav={showTopNav} hasModuleNav={hasModuleNav} />
      </>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--ff-canvas-base)' }}>
      <ShellTitle title={title} />
      <ImpersonationBanner />

      <div className="flex flex-1 min-h-0 overflow-hidden">

      <AppSidebar
        showSidebar={showSidebar}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(c => !c)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        <PwaInstallBanner />

        <AppHeader
          navMode={navMode}
          isAdminHost={isAdminHost}
          onToggleMobileNav={() => setMobileOpen(o => !o)}
          onToggleNavMode={toggleNavMode}
          onOpenCommandPalette={openCommandPalette}
        />

        {/* Horizontal nav bars (top mode, not the admin subdomain). Their heights are pinned so nothing below moves
            while they load. Below lg the 10 tabs do not fit and their menus cannot open inside a scrolling strip, so
            the hamburger drawer (AppSidebar) carries the nav there. */}
        {showTopNav && (
          <div className="relative z-40 hidden lg:block flex-shrink-0">
            <div style={{ height: SHELL_HEIGHTS.topNav }}><AccountingNav /></div>
            {hasModuleNav && (
              <div style={{ height: SHELL_HEIGHTS.moduleNav }}><SecondaryModuleNav moduleId={activeModuleId} /></div>
            )}
          </div>
        )}

        {/* Page content */}
        <main
          className="flex-1 overflow-y-auto relative z-0"
          style={{ background: 'var(--ff-canvas-gradient)' }}
        >
          {isPayrollPath(router.pathname) && <PayrollPeriodBar />}
          <div className="p-4 lg:p-6">{children}</div>
        </main>
      </div>
      </div>

      {/* Command Palette */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />

      {/* Shortcut Help Overlay — triggered by '?' */}
      <ShortcutHelpOverlay
        isOpen={shortcutHelpOpen}
        onClose={() => setShortcutHelpOpen(false)}
        shortcuts={globalShortcuts}
      />

      {/* Onboarding Tour — gated to the dashboard. The tour orients the
          user around top-level navigation; popping it open over banking,
          AR, AP, or VAT screens interrupts task work. Audit Finding 1. */}
      {router.pathname === '/accounting' && !isAdminHost && <AccountingTour />}
    </div>
  );
}
