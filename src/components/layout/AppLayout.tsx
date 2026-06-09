/**
 * Standalone AppLayout for the Accounting app.
 * Supports two nav modes: top-bar (Sage-style, default) or sidebar.
 * User preference persisted in localStorage.
 */

import { useState, useEffect, useRef, ReactNode, useMemo } from 'react';
import { useRouter } from 'next/router';
import Image from 'next/image';
import { useTrackPageVisit } from '@/hooks/useTrackPageVisit';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Menu,
  LogOut,
  User,
  Moon,
  Sun,
  PanelLeft,
  PanelTop,
  Download,
  X as XIcon,
  Search,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useCompany } from '@/contexts/CompanyContext';
import { startSessionHeartbeat } from '@/lib/auth/sessionHeartbeat';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CompanySwitcher } from '@/components/layout/CompanySwitcher';
import { CreateNewMenu } from '@/components/layout/CreateNewMenu';
import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { TableDensityToggle } from '@/components/ui/TableDensityToggle';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { SecondaryModuleNav } from '@/components/accounting/SecondaryModuleNav';
import { getActiveModuleId } from '@/components/accounting/accountingNavConfig';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { ShortcutHelpOverlay } from '@/components/layout/ShortcutHelpOverlay';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import type { ShortcutConfig } from '@/lib/keyboard-shortcuts';
import { AccountingTour } from '@/components/onboarding/AccountingTour';
import { SetupGuideButton } from '@/components/onboarding/SetupGuideButton';
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner';
import { PayrollPeriodBar } from '@/components/payroll/PayrollPeriodBar';
import { DM_Sans } from 'next/font/google';

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans', display: 'swap' });

const AccountingNav = dynamic(
  () => import('@/components/accounting/AccountingNav').then(mod => ({ default: mod.AccountingNav })),
);

const SIDEBAR_COLLAPSED_KEY = 'accounting-sidebar-collapsed';
const NAV_MODE_KEY = 'accounting-nav-mode';
const PWA_INSTALL_DISMISSED_KEY = 'isaflow-pwa-install-dismissed';

type NavMode = 'top' | 'side';

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
  const { user, loading, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { companyRole, activeCompany } = useCompany();

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

  // PWA install prompt
  const deferredPromptRef = useRef<Event | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  useEffect(() => {
    const savedMode = localStorage.getItem(NAV_MODE_KEY) as NavMode | null;
    if (savedMode === 'top' || savedMode === 'side') setNavMode(savedMode);
    const savedCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (savedCollapsed !== null) setCollapsed(JSON.parse(savedCollapsed) as boolean);
    setHydrated(true);
  }, []);

  // Listen for PWA install prompt
  useEffect(() => {
    const dismissed = localStorage.getItem(PWA_INSTALL_DISMISSED_KEY);
    if (dismissed) return;

    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e;
      setShowInstallBanner(true);
      // Auto-hide after 10s so it doesn't permanently eat vertical space.
      // Still available via the Install button in browser's address bar.
      setTimeout(() => setShowInstallBanner(false), 10_000);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    if (hydrated) {
      localStorage.setItem(NAV_MODE_KEY, navMode);
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
    }
  }, [collapsed, navMode, hydrated]);

  // ─── Global keyboard shortcuts ────────────────────────────────────────────
  const globalShortcuts = useMemo<ShortcutConfig[]>(() => [
    {
      key: 'ctrl+k',
      label: 'Ctrl+K',
      description: 'Open command palette',
      category: 'global',
      action: () => setCommandPaletteOpen(true),
    },
    {
      key: '?',
      label: '?',
      description: 'Show keyboard shortcuts',
      category: 'global',
      action: () => setShortcutHelpOpen(true),
    },
    // Navigation sequences — press G then the second key within 1 second
    {
      key: 'g d',
      label: 'G then D',
      description: 'Go to Dashboard',
      category: 'navigation',
      action: () => { void router.push('/accounting'); },
    },
    {
      key: 'g s',
      label: 'G then S',
      description: 'Go to Sales',
      category: 'navigation',
      action: () => { void router.push('/accounting/customers'); },
    },
    {
      key: 'g p',
      label: 'G then P',
      description: 'Go to Purchases',
      category: 'navigation',
      action: () => { void router.push('/accounting/suppliers'); },
    },
    {
      key: 'g i',
      label: 'G then I',
      description: 'Go to Inventory',
      category: 'navigation',
      action: () => { void router.push('/accounting/items'); },
    },
    {
      key: 'g b',
      label: 'G then B',
      description: 'Go to Banking',
      category: 'navigation',
      action: () => { void router.push('/accounting/bank-transactions'); },
    },
    {
      key: 'g a',
      label: 'G then A',
      description: 'Go to Accounting',
      category: 'navigation',
      action: () => { void router.push('/accounting/chart-of-accounts'); },
    },
    {
      key: 'g r',
      label: 'G then R',
      description: 'Go to Reports',
      category: 'navigation',
      action: () => { void router.push('/accounting/reports/income-statement'); },
    },
    {
      key: 'g t',
      label: 'G then T',
      description: 'Go to Tax',
      category: 'navigation',
      action: () => { void router.push('/accounting/reports/vat-return'); },
    },
  ], [router]);

  useKeyboardShortcuts(globalShortcuts);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [router.pathname]);

  const toggleNavMode = () => setNavMode(m => m === 'top' ? 'side' : 'top');

  const handleInstall = async () => {
    const prompt = deferredPromptRef.current as (Event & { prompt: () => Promise<void> }) | null;
    if (!prompt) return;
    await prompt.prompt();
    deferredPromptRef.current = null;
    setShowInstallBanner(false);
  };

  const dismissInstall = () => {
    setShowInstallBanner(false);
    localStorage.setItem(PWA_INSTALL_DISMISSED_KEY, '1');
  };

  const userInitials = user
    ? (`${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || user.email?.[0]?.toUpperCase() || 'U')
    : 'U';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gray-950">
        <div className="text-center">
          <LoadingSpinner size="lg" className="mx-auto mb-4" />
          <p className="text-slate-500 dark:text-gray-400 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  // ─── Sidebar content (shared between mobile + desktop sidebar) ────────────

  const SidebarContent = (
    <>
      {/* Logo */}
      <div className={`flex items-center px-4 py-4 border-b border-gray-200 dark:border-gray-700 ${collapsed ? 'justify-center' : ''}`}>
        {collapsed ? (
          <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4 text-slate-900 dark:text-white" />
          </div>
        ) : (
          <Image src="/logo.png" alt="ISAFlow" width={90} height={36} className="h-9 w-auto dark:brightness-0 dark:invert" />
        )}
      </div>

      {/* Nav — uses same TABS config as top nav */}
      <SidebarNav collapsed={collapsed} />

      {/* User area */}
      <div className={`border-t border-gray-200 dark:border-gray-700 p-3 ${collapsed ? 'flex flex-col items-center gap-2' : ''}`}>
        {user && !collapsed && (
          <div className="flex items-center gap-2 px-2 py-2 mb-1">
            <div className="w-7 h-7 bg-teal-700 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-xs text-slate-900 dark:text-white font-semibold">{userInitials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
                {user.firstName} {user.lastName}
              </p>
              {/* Show per-company role only. user.role is the global platform role
                  (usually "viewer") and is not meaningful for normal customers. */}
              {companyRole && (
                <p className="text-xs text-gray-500 truncate capitalize">{companyRole}</p>
              )}
            </div>
          </div>
        )}
        <button
          onClick={() => void logout()}
          title={collapsed ? 'Log out' : undefined}
          className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors ${collapsed ? 'justify-center' : ''}`}
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </>
  );

  const showSidebar = navMode === 'side';

  return (
    <div className={`${dmSans.variable} flex flex-col h-screen overflow-hidden`} style={{ background: 'var(--ff-canvas-base)' }}>
      <ImpersonationBanner />

      <div className="flex flex-1 min-h-0 overflow-hidden">

      {/* ── Desktop sidebar (only in side mode) ──────────────────────────── */}
      {showSidebar && (
        <aside
          className={`hidden lg:flex flex-col transition-all duration-300 flex-shrink-0 ${collapsed ? 'w-16' : 'w-64'}`}
          style={{ background: 'var(--ff-canvas-base)', borderRight: '1px solid var(--ff-canvas-border)' }}
        >
          {SidebarContent}

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="flex items-center justify-center h-10 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
            style={{ borderTop: '1px solid var(--ff-canvas-border)' }}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed
              ? <ChevronRight className="w-4 h-4" />
              : <ChevronLeft className="w-4 h-4" />
            }
          </button>
        </aside>
      )}

      {/* ── Mobile sidebar overlay (always available for mobile) ──────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 flex flex-col lg:hidden transition-transform duration-300 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ background: 'var(--ff-canvas-base)', borderRight: '1px solid var(--ff-canvas-border)' }}
      >
        {SidebarContent}
      </aside>

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* PWA install banner */}
        {showInstallBanner && (
          <div className="bg-teal-600 text-white px-4 py-2 flex items-center justify-between text-sm flex-shrink-0">
            <div className="flex items-center gap-2">
              <Download className="w-4 h-4" />
              <span>Install IsaFlow for a faster, app-like experience</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleInstall} className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded text-xs font-medium transition-colors">
                Install
              </button>
              <button onClick={dismissInstall} className="p-1 hover:bg-white/20 rounded transition-colors" aria-label="Dismiss">
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Header bar */}
        <header className="h-14 flex items-center px-4 gap-3 flex-shrink-0" style={{ background: 'var(--ff-canvas-mid)', borderBottom: '1px solid var(--ff-canvas-border)' }}>
          {/* Mobile hamburger */}
          <button
            className="lg:hidden text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            onClick={() => setMobileOpen(o => !o)}
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Logo (in top-nav mode, show logo here; in side mode it's in the sidebar) */}
          <Image src="/logo.png" alt="ISAFlow" width={80} height={32} className="h-8 w-auto hidden sm:block dark:brightness-0 dark:invert" />

          {/* Company switcher (hidden on admin subdomain) */}
          {!isAdminHost && (
            <div data-tour="company-switcher">
              <CompanySwitcher />
            </div>
          )}

          <div className="flex-1" />

          {/* Quick create menu (hidden on admin subdomain) */}
          {!isAdminHost && <CreateNewMenu />}

          {/* Command palette trigger */}
          <button
            data-tour="command-palette"
            onClick={() => setCommandPaletteOpen(true)}
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] hover:border-teal-400 hover:text-[var(--ff-text-primary)] transition-colors"
            title="Search (Ctrl+K)"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="text-xs">Search</span>
            <kbd className="ml-1 px-1 py-0.5 text-[10px] bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] rounded">
              Ctrl+K
            </kbd>
          </button>

          {/* Mobile search icon */}
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="sm:hidden p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
            title="Search"
            aria-label="Open search"
          >
            <Search className="w-4 h-4" />
          </button>

          {/* Setup guide (hidden on admin subdomain) */}
          {!isAdminHost && <SetupGuideButton />}

          {/* Settings cog (hidden on admin subdomain) */}
          {!isAdminHost && <SettingsMenu />}

          {/* Nav mode toggle */}
          <button
            onClick={toggleNavMode}
            className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
            title={navMode === 'top' ? 'Switch to sidebar navigation' : 'Switch to top navigation'}
          >
            {navMode === 'top' ? <PanelLeft className="w-4 h-4" /> : <PanelTop className="w-4 h-4" />}
          </button>

          {/* Table density toggle */}
          <TableDensityToggle />

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* User info */}
          {user && (
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <User className="w-4 h-4" />
              <span className="hidden sm:inline truncate max-w-[160px]">
                {user.firstName} {user.lastName}
              </span>
            </div>
          )}

          {/* Logout (visible in top-nav mode where sidebar user area is hidden) */}
          {!showSidebar && (
            <button
              onClick={() => void logout()}
              className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
              title="Log out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </header>

        {/* Horizontal nav bar (only in top mode, hidden on admin subdomain) */}
        {!showSidebar && !isAdminHost && (
          <div className="relative z-40">
            <AccountingNav />
            <SecondaryModuleNav moduleId={activeModuleId} />
          </div>
        )}

        {/* Page content */}
        <main
          className="flex-1 overflow-y-auto relative z-0"
          style={{ background: 'var(--ff-canvas-gradient)' }}
        >
          {router.pathname.startsWith('/payroll') && <PayrollPeriodBar />}
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
