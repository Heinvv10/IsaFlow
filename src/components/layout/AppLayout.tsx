/**
 * Standalone AppLayout for the Accounting app.
 * Supports two nav modes: top-bar (Sage-style, default) or sidebar.
 * User preference persisted in localStorage.
 */

import { useState, useEffect, useRef, ReactNode, useMemo } from 'react';
import { useRouter } from 'next/router';
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
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CompanySwitcher } from '@/components/layout/CompanySwitcher';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { ShortcutHelpOverlay } from '@/components/layout/ShortcutHelpOverlay';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import type { ShortcutConfig } from '@/lib/keyboard-shortcuts';
import { AccountingTour } from '@/components/onboarding/AccountingTour';

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
  const { user, loading, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { companyRole } = useCompany();

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
      key: 'g c',
      label: 'G then C',
      description: 'Go to Customers',
      category: 'navigation',
      action: () => { void router.push('/accounting?tab=customers'); },
    },
    {
      key: 'g s',
      label: 'G then S',
      description: 'Go to Suppliers',
      category: 'navigation',
      action: () => { void router.push('/accounting?tab=suppliers'); },
    },
    {
      key: 'g b',
      label: 'G then B',
      description: 'Go to Banking',
      category: 'navigation',
      action: () => { void router.push('/accounting?tab=banking'); },
    },
    {
      key: 'g a',
      label: 'G then A',
      description: 'Go to Accounts',
      category: 'navigation',
      action: () => { void router.push('/accounting?tab=accounts'); },
    },
    {
      key: 'g r',
      label: 'G then R',
      description: 'Go to Reports',
      category: 'navigation',
      action: () => { void router.push('/accounting?tab=reports'); },
    },
    {
      key: 'g v',
      label: 'G then V',
      description: 'Go to VAT',
      category: 'navigation',
      action: () => { void router.push('/accounting?tab=vat'); },
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
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <LoadingSpinner size="lg" className="mx-auto mb-4" />
          <p className="text-gray-400 text-sm">Loading...</p>
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
            <BookOpen className="w-4 h-4 text-white" />
          </div>
        ) : (
          <img src="/logo.png" alt="ISAFlow" className="h-9 w-auto dark:brightness-0 dark:invert" />
        )}
      </div>

      {/* Nav — uses same TABS config as top nav */}
      <SidebarNav collapsed={collapsed} />

      {/* User area */}
      <div className={`border-t border-gray-200 dark:border-gray-700 p-3 ${collapsed ? 'flex flex-col items-center gap-2' : ''}`}>
        {user && !collapsed && (
          <div className="flex items-center gap-2 px-2 py-2 mb-1">
            <div className="w-7 h-7 bg-teal-700 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-xs text-white font-semibold">{userInitials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
                {user.firstName} {user.lastName}
              </p>
              <p className="text-xs text-gray-500 truncate capitalize">{companyRole || user.role}</p>
            </div>
          </div>
        )}
        <button
          onClick={() => void logout()}
          title={collapsed ? 'Log out' : undefined}
          className={`
            flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-gray-500 dark:text-gray-400
            hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors
            ${collapsed ? 'justify-center' : ''}
          `}
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </>
  );

  const showSidebar = navMode === 'side';

  return (
    <div className="flex h-screen bg-white dark:bg-gray-950 overflow-hidden">

      {/* ── Desktop sidebar (only in side mode) ──────────────────────────── */}
      {showSidebar && (
        <aside
          className={`
            hidden lg:flex flex-col bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700
            transition-all duration-300 flex-shrink-0
            ${collapsed ? 'w-16' : 'w-64'}
          `}
        >
          {SidebarContent}

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="flex items-center justify-center h-10 border-t border-gray-200 dark:border-gray-700 text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
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
        className={`
          fixed inset-y-0 left-0 z-40 w-64 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700
          flex flex-col lg:hidden transition-transform duration-300
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
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
        <header className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 h-14 flex items-center px-4 gap-3 flex-shrink-0">
          {/* Mobile hamburger */}
          <button
            className="lg:hidden text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            onClick={() => setMobileOpen(o => !o)}
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Logo (in top-nav mode, show logo here; in side mode it's in the sidebar) */}
          <img src="/logo.png" alt="ISAFlow" className="h-8 w-auto hidden sm:block dark:brightness-0 dark:invert" />

          {/* Company switcher */}
          <div data-tour="company-switcher">
            <CompanySwitcher />
          </div>

          <div className="flex-1" />

          {/* Command palette trigger */}
          <button
            data-tour="command-palette"
            onClick={() => setCommandPaletteOpen(true)}
            className="
              hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm
              text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-secondary)]
              border border-[var(--ff-border-primary)]
              hover:border-teal-400 hover:text-[var(--ff-text-primary)]
              transition-colors
            "
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
            className="sm:hidden p-2 rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            title="Search"
            aria-label="Open search"
          >
            <Search className="w-4 h-4" />
          </button>

          {/* Nav mode toggle */}
          <button
            onClick={toggleNavMode}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            title={navMode === 'top' ? 'Switch to sidebar navigation' : 'Switch to top navigation'}
          >
            {navMode === 'top' ? <PanelLeft className="w-4 h-4" /> : <PanelTop className="w-4 h-4" />}
          </button>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* User info */}
          {user && (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
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
              className="p-2 rounded-lg text-gray-400 hover:text-red-500 transition-colors"
              title="Log out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </header>

        {/* Horizontal nav bar (only in top mode) */}
        {!showSidebar && (
          <div className="relative z-40">
            <AccountingNav />
          </div>
        )}

        {/* Page content */}
        <main className="flex-1 overflow-y-auto bg-white dark:bg-gray-950 p-4 lg:p-6 relative z-0">
          {children}
        </main>
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

      {/* Onboarding Tour */}
      <AccountingTour />
    </div>
  );
}
